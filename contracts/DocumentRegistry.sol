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

    // Gli stati in cui può trovarsi un dossier investigativo
    enum DossierState { SUBMITTED, UNDER_ANALYSIS, FISCAL_REVIEW, IN_INVESTIGATION, ARCHIVED }

    struct Dossier {
        address submitter;       // Chi ha inviato la segnalazione (la Banca)
        address currentHandler;  // Chi ha in carico il dossier ora (es. UIF, AdE, GdF)
        DossierState state;      // Stato attuale
        string ipfsCid;          // Il CID del documento crittografato su IPFS
        string encryptedDEK;     // La Busta Digitale (chiave simmetrica cifrata con la pubKey dell'handler)
        uint256 lastUpdated;
    }

    // Mappatura principale: ID univoco del Dossier => Dati del Dossier
    mapping(bytes32 => Dossier) public dossiers;

    // Riferimento al registro delle credenziali
    ICredentialRegistry public credentialRegistry;

    // Eventi per costruire l'Audit Trail
    event DossierSubmitted(bytes32 indexed dossierId, address indexed submitter, string ipfsCid);
    event DossierStateTransitioned(bytes32 indexed dossierId, DossierState newState, address indexed handler);

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
    // La banca deve fornire l'ID della sua credenziale (VC) per dimostrare di essere autorizzata
    function submitDossier(
        bytes32 dossierId,
        bytes32 bankCredentialId,
        address targetAuthority, // Di solito l'indirizzo della UIF
        string calldata initialCid,
        string calldata initialEncryptedDEK
    ) external {
        require(dossiers[dossierId].lastUpdated == 0, "Errore: Dossier gia' esistente");

        // Verifica che la banca abbia una credenziale valida attiva
        require(credentialRegistry.verifyCredential(bankCredentialId), "Errore: Banca non autorizzata o credenziale revocata");

        ( , address subject, , , ) = credentialRegistry.getCredential(bankCredentialId);
        require(subject == msg.sender, "Errore: La credenziale non appartiene a te");

        dossiers[dossierId] = Dossier({
            submitter: msg.sender,
            currentHandler: targetAuthority, // Passa la palla alla UIF
            state: DossierState.SUBMITTED,
            ipfsCid: initialCid,
            encryptedDEK: initialEncryptedDEK,
            lastUpdated: block.timestamp
        });

        emit DossierSubmitted(dossierId, msg.sender, initialCid);
    }

    // TRANSIZIONE DI STATO E RE-WRAPPING (Chiamata dalle Autorità)
    // L'autorità in carico analizza il documento, cambia stato, aggiorna l'IPFS (se aggiunge perizie)
    // e "richiude" la busta digitale (nuova encryptedDEK) per l'autorità successiva.
    function transitionDossier(
        bytes32 dossierId,
        DossierState newState,
        address nextHandler,
        string calldata newCid,
        string calldata newEncryptedDEK
    ) external {
        Dossier storage d = dossiers[dossierId];
        require(d.lastUpdated != 0, "Errore: Dossier inesistente");
        require(msg.sender == d.currentHandler, "Errore: Non hai in carico questo dossier");
        require(uint8(newState) > uint8(d.state), "Errore: Il dossier puo' solo avanzare di stato");

        d.state = newState;
        d.currentHandler = nextHandler;
        d.ipfsCid = newCid;
        d.encryptedDEK = newEncryptedDEK;
        d.lastUpdated = block.timestamp;

        emit DossierStateTransitioned(dossierId, newState, msg.sender);
    }

    // Autorizzazione aggiornamenti (UUPS)
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}