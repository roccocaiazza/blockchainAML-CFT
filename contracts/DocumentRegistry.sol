// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

// Interfaccia minima per verificare se una banca è autorizzata tramite VC
interface ICredentialRegistry {
    function getCredential(bytes32 credId) external view returns (
        address issuer, address subject, bytes32 credentialHash, uint256 issuedAt, bool revoked
    );
    function verifyCredential(bytes32 credId) external view returns (bool);
}

// Interfaccia minima per verificare se un dossier ha una disputa attiva
interface IDelegationManager {
    function activeDisputes(bytes32 dossierId) external view returns (bool);
}

contract DocumentRegistry is Initializable, OwnableUpgradeable, UUPSUpgradeable {

    error DossierAlreadyExists();
    error BankNotAuthorized();
    error NotYourCredential();
    error DossierNotFound();
    error NotDossierHandler();
    error InvalidStateTransition();
    error DossierArchived();
    error InvalidDEKCommitment();
    // Emesso quando si tenta di avanzare un dossier in disputa attiva
    error DossierFrozen();
    // Emesso quando la banca non indirizza la SOS alla UIF
    error MustSubmitToUIF();

    // Ciclo di vita del dossier investigativo
    enum DossierState { SUBMITTED, UNDER_ANALYSIS, FISCAL_REVIEW, IN_INVESTIGATION, ARCHIVED }

    struct Dossier {
        address submitter;       // Banca che ha inviato la SOS
        address currentHandler;  // Autorità attualmente in carico
        DossierState state;
        bytes ipfsCid;           // CID del documento cifrato su IPFS
        bytes encryptedDEK;      // Busta Digitale: DEK cifrata con la pubKey dell'handler
        bytes32 dekCommitment;   // SHA-256(DEK) notarizzato on-chain per verifica di integrità
        uint256 lastUpdated;
    }

    mapping(bytes32 => Dossier) public dossiers;

    ICredentialRegistry public credentialRegistry;

    // Riferimento al DelegationManager per leggere activeDisputes e bloccare il dossier in caso di disputa
    IDelegationManager public delegationManager;

    // Indirizzo della UIF, unico destinatario obbligatorio della SOS iniziale
    address public uifAddress;

    // Emessi per costruire l'audit trail immutabile
    event DossierSubmitted(bytes32 indexed dossierId, address indexed submitter, bytes ipfsCid, bytes32 dekCommitment);
    event DossierStateTransitioned(bytes32 indexed dossierId, DossierState newState, address indexed handler, bytes32 dekCommitment);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // Aggiunto _uifAddress come parametro obbligatorio: forza la SOS verso la UIF come primo handler
    function initialize(
        address initialOwner,
        address _credentialRegistryAddress,
        address _uifAddress
    ) initializer public {
        __Ownable_init(initialOwner);
        credentialRegistry = ICredentialRegistry(_credentialRegistryAddress);
        uifAddress = _uifAddress;
    }

    // Setter per il DelegationManager, chiamabile solo dall'owner dopo il deploy
    // (evita la dipendenza circolare nell'initialize: DelegationManager richiede DocumentRegistry già deployato)
    function setDelegationManager(address _delegationManager) external onlyOwner {
        delegationManager = IDelegationManager(_delegationManager);
    }

    // Sottomette una SOS. Verifica la VC della banca, che il destinatario sia la UIF,
    // e registra il dekCommitment on-chain.
    function submitDossier(
        bytes32 dossierId,
        bytes32 bankCredentialId,
        address targetAuthority,
        bytes calldata initialCid,
        bytes calldata initialEncryptedDEK,
        bytes32 dekCommitment
    ) external {
        if(dossiers[dossierId].lastUpdated != 0) revert DossierAlreadyExists();
        if(dekCommitment == bytes32(0)) revert InvalidDEKCommitment();

        // La SOS deve essere sempre indirizzata alla UIF come primo handler
        if(targetAuthority != uifAddress) revert MustSubmitToUIF();

        if(!credentialRegistry.verifyCredential(bankCredentialId)) revert BankNotAuthorized();

        ( , address subject, , , ) = credentialRegistry.getCredential(bankCredentialId);
        if(subject != msg.sender) revert NotYourCredential();

        dossiers[dossierId] = Dossier({
            submitter: msg.sender,
            currentHandler: targetAuthority,
            state: DossierState.SUBMITTED,
            ipfsCid: initialCid,
            encryptedDEK: initialEncryptedDEK,
            dekCommitment: dekCommitment,
            lastUpdated: block.timestamp
        });

        emit DossierSubmitted(dossierId, msg.sender, initialCid, dekCommitment);
    }

    // Avanza lo stato del dossier con transizioni rigide (Fix #2) e blocco in caso di
    // disputa attiva (Fix #1). Solo l'handler corrente può chiamarla. ARCHIVED è terminale.
    function transitionDossier(
        bytes32 dossierId,
        DossierState newState,
        address nextHandler,
        bytes calldata newCid,
        bytes calldata newEncryptedDEK,
        bytes32 newDekCommitment
    ) external {
        Dossier storage d = dossiers[dossierId];
        if(d.lastUpdated == 0) revert DossierNotFound();
        if(msg.sender != d.currentHandler) revert NotDossierHandler();
        if(d.state == DossierState.ARCHIVED) revert DossierArchived();
        if(newDekCommitment == bytes32(0)) revert InvalidDEKCommitment();

        // Blocca qualsiasi avanzamento se è aperta una disputa crittografica sul dossier
        if(address(delegationManager) != address(0) && delegationManager.activeDisputes(dossierId)) {
            revert DossierFrozen();
        }

        // Matrice di transizioni rigida con possibilità di archiviazione anticipata da qualsiasi stato.
        // Ogni fase può essere chiusa direttamente (es. SOS infondata archiviata dalla UIF prima dell'AdE).
        if (d.state == DossierState.SUBMITTED) {
            if (newState != DossierState.UNDER_ANALYSIS && newState != DossierState.ARCHIVED) revert InvalidStateTransition();
        } else if (d.state == DossierState.UNDER_ANALYSIS) {
            if (newState != DossierState.FISCAL_REVIEW && newState != DossierState.ARCHIVED) revert InvalidStateTransition();
        } else if (d.state == DossierState.FISCAL_REVIEW) {
            if (newState != DossierState.IN_INVESTIGATION && newState != DossierState.ARCHIVED) revert InvalidStateTransition();
        } else if (d.state == DossierState.IN_INVESTIGATION) {
            if (newState != DossierState.ARCHIVED) revert InvalidStateTransition();
        } else {
            revert DossierArchived();
        }

        d.state = newState;
        d.currentHandler = nextHandler;
        d.ipfsCid = newCid;
        d.encryptedDEK = newEncryptedDEK;
        d.dekCommitment = newDekCommitment;
        d.lastUpdated = block.timestamp;

        emit DossierStateTransitioned(dossierId, newState, msg.sender, newDekCommitment);
    }

    // In produzione l'owner va trasferito al PolicyManager per attivare il controllo 3/3 sugli upgrade
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
