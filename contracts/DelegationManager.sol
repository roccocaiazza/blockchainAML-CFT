// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

// Interfaccia per dialogare con il DocumentRegistry e verificare i permessi.
// Il campo dekCommitment è incluso per supportare la verifica di integrità nelle dispute.
interface IDocumentRegistry {
    function dossiers(bytes32 dossierId) external view returns (
        address submitter,
        address currentHandler,
        uint8 state,
        bytes memory ipfsCid,
        bytes memory encryptedDEK,
        bytes32 dekCommitment,
        uint256 lastUpdated
    );
}

contract DelegationManager is Initializable, OwnableUpgradeable, UUPSUpgradeable {

    error NotAuthorizedToDelegate();
    error DelegationIdAlreadyInUse();
    error UnauthorizedRevokeDelegation();
    error OnlyHandlerCanDispute();
    error MaxDepthExceeded();
    error NotCoreAuthority();

    // -------------------------------------------------------------------------
    // COSTANTI
    // -------------------------------------------------------------------------

    /// @dev Profondità massima della catena di sub-deleghe.
    ///      Livello 0 = Core Authority (handler diretto del dossier)
    ///      Livello 1 = es. Comando Provinciale GdF
    ///      Livello 2 = es. Perito Forense (sub-delega terminale)
    uint8 public constant MAX_DELEGATION_DEPTH = 2;

    // -------------------------------------------------------------------------
    // STATO
    // -------------------------------------------------------------------------

    IDocumentRegistry public documentRegistry;

    /// @dev Indirizzi delle tre Autorità Core (UIF, AdE, GdF).
    ///      Impostati una volta sola durante l'inizializzazione.
    mapping(address => bool) public isCoreAuthority;

    // Struttura dati per le deleghe temporanee
    struct Delegation {
        address delegator;          // Chi concede la delega
        address delegatee;          // Chi riceve la delega (es. ufficio territoriale)
        bytes32 dossierId;          // Riferimento al fascicolo
        uint256 expiryTime;         // Scadenza della delega (Time-To-Live)
        bool active;                // Stato di revoca
        bytes32 parentDelegationId; // ID della delega padre (per sub-deleghe)
        uint8 depth;                // Profondità nella catena (0 = emessa da Core Authority)
    }

    mapping(bytes32 => Delegation) public delegations;
    mapping(bytes32 => bool) public activeDisputes;

    // -------------------------------------------------------------------------
    // EVENTI
    // -------------------------------------------------------------------------

    event AccessDelegated(bytes32 indexed delegationId, bytes32 indexed dossierId, address indexed delegator, address delegatee, uint8 depth);
    event DelegationRevoked(bytes32 indexed delegationId);

    /// @dev Emesso quando l'handler corrente segnala un'anomalia (es. DEK corrotta).
    ///      Il campo onChainCommitment riporta il dekCommitment notarizzato on-chain
    ///      per permettere la verifica crittografica ex-post di chi ha inserito la chiave sbagliata.
    event DisputeLogged(bytes32 indexed dossierId, address indexed reporter, string reason, bytes32 onChainCommitment);

    /// @dev Emesso dalla Emergency Policy: una singola Core Authority ha agito in bypass del quorum.
    ///      Registrato inderogabilmente nell'audit trail per verifiche ex-post.
    event EmergencyActionTaken(bytes32 indexed delegationId, address indexed authority, string justification, uint256 timestamp);

    // -------------------------------------------------------------------------
    // INIZIALIZZAZIONE
    // -------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param _coreAuthorities Array dei tre indirizzi Core (UIF, AdE, GdF)
    function initialize(
        address initialOwner,
        address _documentRegistry,
        address[] calldata _coreAuthorities
    ) initializer public {
        __Ownable_init(initialOwner);
        documentRegistry = IDocumentRegistry(_documentRegistry);
        for (uint256 i = 0; i < _coreAuthorities.length; i++) {
            isCoreAuthority[_coreAuthorities[i]] = true;
        }
    }

    // -------------------------------------------------------------------------
    // CREAZIONE DI UNA DELEGA
    // -------------------------------------------------------------------------

    /// @notice Crea una delega temporanea con TTL e profondità controllata.
    /// @param delegationId       ID univoco della nuova delega
    /// @param dossierId          Fascicolo a cui si riferisce la delega
    /// @param delegatee          Destinatario della delega
    /// @param ttl                Durata in secondi (Time-To-Live)
    /// @param parentDelegationId ID della delega padre (bytes32(0) se emessa direttamente da Core Authority)
    function delegateAccess(
        bytes32 delegationId,
        bytes32 dossierId,
        address delegatee,
        uint256 ttl,
        bytes32 parentDelegationId
    ) external {
        (, address currentHandler, , , , , ) = documentRegistry.dossiers(dossierId);

        // Verifica che il chiamante sia l'attuale gestore del dossier o un delegato valido
        if (currentHandler != msg.sender && !checkAccess(parentDelegationId, msg.sender, dossierId)) {
            revert NotAuthorizedToDelegate();
        }
        if (delegations[delegationId].delegator != address(0)) revert DelegationIdAlreadyInUse();

        // Calcola la profondità della nuova delega
        uint8 newDepth = 0;
        if (parentDelegationId != bytes32(0)) {
            uint8 parentDepth = delegations[parentDelegationId].depth;
            if (parentDepth >= MAX_DELEGATION_DEPTH) revert MaxDepthExceeded();
            newDepth = parentDepth + 1;
        }

        delegations[delegationId] = Delegation({
            delegator: msg.sender,
            delegatee: delegatee,
            dossierId: dossierId,
            expiryTime: block.timestamp + ttl,
            active: true,
            parentDelegationId: parentDelegationId,
            depth: newDepth
        });

        emit AccessDelegated(delegationId, dossierId, msg.sender, delegatee, newDepth);
    }

    // -------------------------------------------------------------------------
    // REVOCA MANUALE DELLA DELEGA
    // -------------------------------------------------------------------------

    /// @notice Revoca una delega. Solo il delegante originale può farlo.
    ///         La revoca è "pigra": non propaga attivamente ma viene verificata
    ///         on-demand da checkAccess() risalendo la catena padre-figlio.
    function revokeDelegation(bytes32 delegationId) external {
        if (delegations[delegationId].delegator != msg.sender) revert UnauthorizedRevokeDelegation();
        delegations[delegationId].active = false;
        emit DelegationRevoked(delegationId);
    }

    // -------------------------------------------------------------------------
    // EMERGENCY POLICY — Fast-Track (singola Core Authority, bypass quorum)
    // -------------------------------------------------------------------------

    /// @notice Revoca d'emergenza di una delega nel proprio dominio di competenza,
    ///         senza attendere il quorum delle altre autorità.
    ///         Utilizzabile solo da una Core Authority (UIF, AdE, GdF) e solo per
    ///         deleghe emesse nell'ambito del proprio dominio (delegator == msg.sender
    ///         oppure delegator è un sub-delegato della stessa catena).
    ///         L'azione viene registrata inderogabilmente nell'audit trail on-chain.
    /// @param delegationId  La delega da revocare d'urgenza
    /// @param justification Motivazione dell'azione (es. "Perito compromesso - indagine #X")
    function emergencyRevoke(bytes32 delegationId, string calldata justification) external {
        if (!isCoreAuthority[msg.sender]) revert NotCoreAuthority();

        Delegation storage d = delegations[delegationId];
        // La Core Authority può revocare solo deleghe nel proprio dominio:
        // deve essere il delegante diretto o un antenato nella catena
        if (!_isAncestorOrDelegator(delegationId, msg.sender)) revert NotAuthorizedToDelegate();

        d.active = false;

        // Registrazione obbligatoria nell'audit trail — non può essere omessa
        emit DelegationRevoked(delegationId);
        emit EmergencyActionTaken(delegationId, msg.sender, justification, block.timestamp);
    }

    /// @dev Verifica se `authority` è il delegante diretto o un antenato nella catena della delega.
    function _isAncestorOrDelegator(bytes32 delegationId, address authority) internal view returns (bool) {
        bytes32 current = delegationId;
        // Risale la catena fino alla radice (max MAX_DELEGATION_DEPTH iterazioni)
        for (uint8 i = 0; i <= MAX_DELEGATION_DEPTH; i++) {
            if (current == bytes32(0)) break;
            if (delegations[current].delegator == authority) return true;
            current = delegations[current].parentDelegationId;
        }
        return false;
    }

    // -------------------------------------------------------------------------
    // LAZY REVOCATION — Verifica della catena di fiducia
    // -------------------------------------------------------------------------

    /// @notice Verifica che una delega sia valida, non scaduta e che tutta la catena
    ///         padre-figlio sia ancora attiva. La validità viene ricalcolata dinamicamente
    ///         solo al momento dell'accesso, senza sprecare gas in propagazioni attive.
    function checkAccess(bytes32 delegationId, address user, bytes32 dossierId) public view returns (bool) {
        if (delegationId == bytes32(0)) return false;

        Delegation memory d = delegations[delegationId];

        // Controllo base della delega corrente
        if (!d.active || block.timestamp > d.expiryTime || d.delegatee != user || d.dossierId != dossierId) {
            return false;
        }

        // Se deriva da una delega padre, controlla ricorsivamente anche quella
        if (d.parentDelegationId != bytes32(0)) {
            return checkAccess(d.parentDelegationId, d.delegator, dossierId);
        }

        return true;
    }

    // -------------------------------------------------------------------------
    // SEGNALAZIONE ANOMALIE — Key Commitment Dispute
    // -------------------------------------------------------------------------

    /// @notice Segnala un'anomalia sul dossier (es. DEK corrotta o busta digitale manomessa).
    ///         Emette il dekCommitment notarizzato on-chain per permettere la verifica
    ///         crittografica ex-post: se SHA-256(DEK_decifrata) != onChainCommitment,
    ///         la prova matematica identifica chi ha inserito la chiave sbagliata.
    function logDispute(bytes32 dossierId, string calldata reason) external {
        (, address currentHandler, , , , bytes32 commitment, ) = documentRegistry.dossiers(dossierId);
        if (currentHandler != msg.sender) revert OnlyHandlerCanDispute();

        activeDisputes[dossierId] = true;

        emit DisputeLogged(dossierId, msg.sender, reason, commitment);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}