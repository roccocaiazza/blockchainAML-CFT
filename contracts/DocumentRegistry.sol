// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

// Interfaccia minima per parlare con il CredentialRegistry e verificare se una banca è autorizzata
interface ICredentialRegistry {
    function getCredential(bytes32 credId) external view returns (
        address issuer, address subject, bytes32 credentialHash, uint256 issuedAt, bool revoked
    );
    function verifyCredential(bytes32 credId) external view returns (bool);
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

    // Gli stati in cui può trovarsi un dossier investigativo
    enum DossierState { SUBMITTED, UNDER_ANALYSIS, FISCAL_REVIEW, IN_INVESTIGATION, ARCHIVED }

    struct Dossier {
        address submitter;       // Chi ha inviato la segnalazione (la Banca)
        address currentHandler;  // Chi ha in carico il dossier ora (es. UIF, AdE, GdF)
        DossierState state;      // Stato attuale
        bytes ipfsCid;           // Il CID del documento crittografato su IPFS
        bytes encryptedDEK;      // La Busta Digitale (chiave simmetrica cifrata con la pubKey dell'handler)
        // KEY COMMITMENT: hash SHA-256 della DEK in chiaro, notarizzato on-chain alla fonte.
        // Permette al ricevente di verificare che la DEK decifrata corrisponda a quella originale
        // e di lanciare un DisputeLogged con prova crittografica in caso di incongruenza.
        bytes32 dekCommitment;
        uint256 lastUpdated;
    }

    // Mappatura principale: ID univoco del Dossier => Dati del Dossier
    mapping(bytes32 => Dossier) public dossiers;

    // Riferimento al registro delle credenziali
    ICredentialRegistry public credentialRegistry;

    // Eventi per costruire l'Audit Trail
    event DossierSubmitted(bytes32 indexed dossierId, address indexed submitter, bytes ipfsCid, bytes32 dekCommitment);
    event DossierStateTransitioned(bytes32 indexed dossierId, DossierState newState, address indexed handler, bytes32 dekCommitment);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // Inizializzazione del Proxy
    function initialize(address initialOwner, address _credentialRegistryAddress) initializer public {
        __Ownable_init(initialOwner);
        credentialRegistry = ICredentialRegistry(_credentialRegistryAddress);
    }

    // CREAZIONE DEL DOSSIER (Chiamata dalla Banca)
    // La banca deve fornire l'ID della sua credenziale (VC) per dimostrare di essere autorizzata.
    // Il parametro dekCommitment è SHA-256(DEK) calcolato off-chain prima del key wrapping:
    // permette al ricevente di verificare l'integrità della busta digitale dopo la decifratura.
    function submitDossier(
        bytes32 dossierId,
        bytes32 bankCredentialId,
        address targetAuthority, // Di solito l'indirizzo della UIF
        bytes calldata initialCid,
        bytes calldata initialEncryptedDEK,
        bytes32 dekCommitment    // SHA-256(DEK) in chiaro, calcolato off-chain
    ) external {
        if(dossiers[dossierId].lastUpdated != 0) revert DossierAlreadyExists();
        if(dekCommitment == bytes32(0)) revert InvalidDEKCommitment();

        // Verifica che la banca abbia una credenziale valida attiva
        if(!credentialRegistry.verifyCredential(bankCredentialId)) revert BankNotAuthorized();

        ( , address subject, , , ) = credentialRegistry.getCredential(bankCredentialId);
        if(subject != msg.sender) revert NotYourCredential();

        dossiers[dossierId] = Dossier({
            submitter: msg.sender,
            currentHandler: targetAuthority, // Passa la palla alla UIF
            state: DossierState.SUBMITTED,
            ipfsCid: initialCid,
            encryptedDEK: initialEncryptedDEK,
            dekCommitment: dekCommitment,
            lastUpdated: block.timestamp
        });

        emit DossierSubmitted(dossierId, msg.sender, initialCid, dekCommitment);
    }

    // TRANSIZIONE DI STATO E RE-WRAPPING (Chiamata dalle Autorità)
    // L'autorità in carico analizza il documento, cambia stato, aggiorna l'IPFS (se aggiunge perizie)
    // e "richiude" la busta digitale (nuova encryptedDEK) per l'autorità successiva.
    // Il nuovo dekCommitment notarizza SHA-256 della DEK usata per il re-wrapping.
    function transitionDossier(
        bytes32 dossierId,
        DossierState newState,
        address nextHandler,
        bytes calldata newCid,
        bytes calldata newEncryptedDEK,
        bytes32 newDekCommitment  // SHA-256(DEK) della nuova busta digitale
    ) external {
        Dossier storage d = dossiers[dossierId];
        if(d.lastUpdated == 0) revert DossierNotFound();
        if(msg.sender != d.currentHandler) revert NotDossierHandler();
        // Blocco esplicito sullo stato terminale ARCHIVED
        if(d.state == DossierState.ARCHIVED) revert DossierArchived();
        if(uint8(newState) <= uint8(d.state)) revert InvalidStateTransition();
        if(newDekCommitment == bytes32(0)) revert InvalidDEKCommitment();

        d.state = newState;
        d.currentHandler = nextHandler;
        d.ipfsCid = newCid;
        d.encryptedDEK = newEncryptedDEK;
        d.dekCommitment = newDekCommitment;
        d.lastUpdated = block.timestamp;

        emit DossierStateTransitioned(dossierId, newState, msg.sender, newDekCommitment);
    }

    // Autorizzazione aggiornamenti (UUPS): delegata al PolicyManager tramite onlyOwner.
    // L'owner deve essere trasferito al PolicyManager dopo il deploy per attivare
    // il controllo di unanimità 3/3 sugli upgrade.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}