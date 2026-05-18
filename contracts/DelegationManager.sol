// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

// Interfaccia per dialogare con il DocumentRegistry e verificare i permessi
interface IDocumentRegistry {
    function dossiers(bytes32 dossierId) external view returns (
        address submitter, address currentHandler, uint8 state, string memory ipfsCid, string memory encryptedDEK, uint256 lastUpdated
    );
}

contract DelegationManager is Initializable, OwnableUpgradeable, UUPSUpgradeable {

    IDocumentRegistry public documentRegistry;

    // Struttura dati per le deleghe temporanee
    struct Delegation {
        address delegator;          // Chi concede la delega
        address delegatee;          // Chi riceve la delega (es. ufficio territoriale)
        bytes32 dossierId;          // Riferimento al fascicolo
        uint256 expiryTime;         // Scadenza della delega (Time-To-Live)
        bool active;                // Stato di revoca
        bytes32 parentDelegationId; // ID della delega padre (per sub-deleghe)
    }

    mapping(bytes32 => Delegation) public delegations;
    mapping(bytes32 => bool) public activeDisputes;

    event AccessDelegated(bytes32 indexed delegationId, bytes32 indexed dossierId, address indexed delegator, address delegatee);
    event DelegationRevoked(bytes32 indexed delegationId);
    event DisputeLogged(bytes32 indexed dossierId, address indexed reporter, string reason);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner, address _documentRegistry) initializer public {
        __Ownable_init(initialOwner);
        documentRegistry = IDocumentRegistry(_documentRegistry);
    }

    // CREAZIONE DI UNA DELEGA
    function delegateAccess(
        bytes32 delegationId,
        bytes32 dossierId,
        address delegatee,
        uint256 ttl,
        bytes32 parentDelegationId
    ) external {
        (, address currentHandler, , , , ) = documentRegistry.dossiers(dossierId);

        // Verifica che il chiamante sia l'attuale gestore del dossier o un delegato valido
        require(
            currentHandler == msg.sender || checkAccess(parentDelegationId, msg.sender, dossierId),
            "Errore di Accesso: Non hai i permessi per delegare questo dossier"
        );
        require(delegations[delegationId].delegator == address(0), "Errore: ID Delega gia' in uso");

        delegations[delegationId] = Delegation({
            delegator: msg.sender,
            delegatee: delegatee,
            dossierId: dossierId,
            expiryTime: block.timestamp + ttl,
            active: true,
            parentDelegationId: parentDelegationId
        });

        emit AccessDelegated(delegationId, dossierId, msg.sender, delegatee);
    }

    // REVOCA MANUALE DELLA DELEGA
    function revokeDelegation(bytes32 delegationId) external {
        require(delegations[delegationId].delegator == msg.sender, "Errore: Solo il delegante puo' revocare");
        delegations[delegationId].active = false;

        emit DelegationRevoked(delegationId);
    }

    // LAZY REVOCATION E VERIFICA DELLA CATENA DI FIDUCIA
    // Verifica iterativamente che la delega sia valida, non scaduta e che tutte le deleghe "padre" siano ancora attive.
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

    //SEGNALAZIONE ANOMALIE (es. Busta Digitale compromessa)
    function logDispute(bytes32 dossierId, string calldata reason) external {
        (, address currentHandler, , , , ) = documentRegistry.dossiers(dossierId);
        require(currentHandler == msg.sender, "Errore: Solo il gestore puo' aprire una disputa su questo dossier");

        activeDisputes[dossierId] = true;

        emit DisputeLogged(dossierId, msg.sender, reason);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}