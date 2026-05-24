// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

// Interfaccia per leggere i dati del dossier dal DocumentRegistry
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

// isActiveByAddress ritorna false se l'utente è registrato ma il DID è stato revocato,
// true in tutti gli altri casi (non registrato = non revocato = permesso).
interface IDIDRegistry {
    function isActiveByAddress(address owner) external view returns (bool);
    function getDomain(address owner) external view returns (bytes32);
}

contract DelegationManager is Initializable, OwnableUpgradeable, UUPSUpgradeable {

    error NotAuthorizedToDelegate();
    error DelegationIdAlreadyInUse();
    error UnauthorizedRevokeDelegation();
    error OnlyHandlerCanDispute();
    error MaxDepthExceeded();
    error NotCoreAuthority();
    error DisputeNotActive();
    error DomainMismatch();
    error CooldownActive();
    error HandlerBlacklisted();

    // Profondità massima della catena di sub-deleghe (0=Core, 1=Provinciale, 2=Perito)
    uint8 public constant MAX_DELEGATION_DEPTH = 2;

    IDocumentRegistry public documentRegistry;

    // DIDRegistry per verificare che il DID del delegatee sia ancora attivo in checkAccess
    IDIDRegistry public didRegistry;

    // Indirizzi delle tre Autorità Core (UIF, AdE, GdF), impostati all'inizializzazione
    mapping(address => bool) public isCoreAuthority;

    struct Delegation {
        address delegator;
        address delegatee;
        bytes32 dossierId;
        uint256 expiryTime;         // Scadenza TTL
        bool active;
        bytes32 parentDelegationId; // Delega padre per sub-deleghe
        uint8 depth;                // Profondità nella catena
    }

    mapping(bytes32 => Delegation) public delegations;
    mapping(bytes32 => bool) public activeDisputes;
    mapping(address => uint256) public lastDisputeTime;
    mapping(address => bool) public blacklistedHandlers;

    event AccessDelegated(bytes32 indexed delegationId, bytes32 indexed dossierId, address indexed delegator, address delegatee, uint8 depth);
    event DelegationRevoked(bytes32 indexed delegationId);

    // Emesso quando l'handler segnala una DEK corrotta. Include il dekCommitment on-chain per la prova crittografica.
    event DisputeLogged(bytes32 indexed dossierId, address indexed reporter, string reason, bytes32 onChainCommitment);

    // Emesso da emergencyRevoke. Registrato nell'audit trail per verifiche ex-post.
    event EmergencyActionTaken(bytes32 indexed delegationId, address indexed authority, string justification, uint256 timestamp);
    event DisputeResolved(bytes32 indexed dossierId, address indexed resolver);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address initialOwner,
        address _documentRegistry,
        address[] calldata _coreAuthorities,
        address _didRegistry
    ) initializer public {
        __Ownable_init(initialOwner);
        documentRegistry = IDocumentRegistry(_documentRegistry);
        didRegistry = IDIDRegistry(_didRegistry);
        for (uint256 i = 0; i < _coreAuthorities.length; i++) {
            isCoreAuthority[_coreAuthorities[i]] = true;
        }
    }

    // Crea una delega temporanea con TTL. Verifica autorizzazione e profondità massima.
    function delegateAccess(
        bytes32 delegationId,
        bytes32 dossierId,
        address delegatee,
        uint256 ttl,
        bytes32 parentDelegationId
    ) external {
        (, address currentHandler, , , , , ) = documentRegistry.dossiers(dossierId);

        if (currentHandler != msg.sender && !checkAccess(parentDelegationId, msg.sender, dossierId)) {
            revert NotAuthorizedToDelegate();
        }
        if (delegations[delegationId].delegator != address(0)) revert DelegationIdAlreadyInUse();

        // Domain Enforcement: delegator e delegatee devono appartenere allo stesso dominio istituzionale.
        // Se non hanno un DID, getDomain ritorna bytes32(0), impedendo deleghe sicure.
        if (address(didRegistry) != address(0)) {
            bytes32 delegatorDomain = didRegistry.getDomain(msg.sender);
            bytes32 delegateeDomain = didRegistry.getDomain(delegatee);
            if (delegatorDomain == bytes32(0) || delegatorDomain != delegateeDomain) {
                revert DomainMismatch();
            }
        }

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

    // Revoca manuale da parte del delegante. La revoca è pigra: non propaga, viene verificata on-demand.
    function revokeDelegation(bytes32 delegationId) external {
        if (delegations[delegationId].delegator != msg.sender) revert UnauthorizedRevokeDelegation();
        delegations[delegationId].active = false;
        emit DelegationRevoked(delegationId);
    }

    // Revoca urgente senza quorum. Solo Core Authority, solo nel proprio dominio.
    // Registra obbligatoriamente EmergencyActionTaken nell'audit trail.
    function emergencyRevoke(bytes32 delegationId, string calldata justification) external {
        if (!isCoreAuthority[msg.sender]) revert NotCoreAuthority();

        Delegation storage d = delegations[delegationId];
        if (!_isAncestorOrDelegator(delegationId, msg.sender)) revert NotAuthorizedToDelegate();

        d.active = false;

        emit DelegationRevoked(delegationId);
        emit EmergencyActionTaken(delegationId, msg.sender, justification, block.timestamp);
    }

    // Risale la catena delle deleghe per verificare se authority è delegante o antenato.
    function _isAncestorOrDelegator(bytes32 delegationId, address authority) internal view returns (bool) {
        bytes32 current = delegationId;
        for (uint8 i = 0; i <= MAX_DELEGATION_DEPTH; i++) {
            if (current == bytes32(0)) break;
            if (delegations[current].delegator == authority) return true;
            current = delegations[current].parentDelegationId;
        }
        return false;
    }

    // Verifica la validità di una delega risalendo ricorsivamente la catena padre-figlio (Lazy Revocation).
    // Verifica anche che il DID del delegatee sia ancora attivo nel DIDRegistry.
    // Se il DID è stato revocato, la delega è invalidata automaticamente senza dover chiamare revokeDelegation.
    // Se il delegatee non ha un DID registrato, il controllo viene saltato (backward compatible).
    function checkAccess(bytes32 delegationId, address user, bytes32 dossierId) public view returns (bool) {
        if (delegationId == bytes32(0)) return false;

        Delegation memory d = delegations[delegationId];

        if (!d.active || block.timestamp > d.expiryTime || d.delegatee != user || d.dossierId != dossierId) {
            return false;
        }

        // Se il DIDRegistry è configurato e il delegatee ha un DID esplicitamente revocato,
        // la delega è automaticamente invalidata senza dover chiamare revokeDelegation.
        if (address(didRegistry) != address(0) && !didRegistry.isActiveByAddress(user)) {
            return false;
        }

        // Se l'utente è stato blacklistato (Slashing Logico per False Dispute), perde tutti gli accessi.
        if (blacklistedHandlers[user]) {
            return false;
        }

        if (d.parentDelegationId != bytes32(0)) {
            return checkAccess(d.parentDelegationId, d.delegator, dossierId);
        }

        return true;
    }

    // Segnala un'anomalia crittografica sul dossier. Emette il dekCommitment on-chain come prova.
    function logDispute(bytes32 dossierId, string calldata reason) external {
        if (block.timestamp < lastDisputeTime[msg.sender] + 24 hours) revert CooldownActive();
        
        (, address currentHandler, , , , bytes32 commitment, ) = documentRegistry.dossiers(dossierId);
        if (currentHandler != msg.sender) revert OnlyHandlerCanDispute();

        lastDisputeTime[msg.sender] = block.timestamp;
        activeDisputes[dossierId] = true;

        emit DisputeLogged(dossierId, msg.sender, reason, commitment);
    }

    // Risolve una disputa attiva su un dossier, riabilitando le transizioni di stato.
    // Chiamabile solo da una Core Authority. Supporta lo Slashing Logico se la disputa era dolosa.
    function resolveDispute(bytes32 dossierId, bool isMalicious) external {
        if (!isCoreAuthority[msg.sender]) revert NotCoreAuthority();
        if (!activeDisputes[dossierId]) revert DisputeNotActive();

        if (isMalicious) {
            (, address currentHandler, , , , , ) = documentRegistry.dossiers(dossierId);
            blacklistedHandlers[currentHandler] = true;
        }

        activeDisputes[dossierId] = false;

        emit DisputeResolved(dossierId, msg.sender);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
