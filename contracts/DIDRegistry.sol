// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract DIDRegistry is Initializable, OwnableUpgradeable, UUPSUpgradeable {

    // Struttura dati per memorizzare le informazioni dell'Identità
    struct DIDDocument {
        address owner;
        string publicKey;       // Chiave pubblica per le Buste Digitali (es. crittografia RSA/ECC)
        string serviceEndpoint; // URL per contattare il nodo off-chain dell'ente
        uint256 createdAt;
        uint256 updatedAt;
        bool active;
    }

    // Mappature per collegare gli indirizzi Ethereum ai DID e viceversa
    mapping(address => DIDDocument) private _documents;
    mapping(address => bool) private _registered;
    mapping(string => address) private _didToOwner;

    // Eventi per l'Audit Trail
    event DIDRegistered(address indexed owner, string did, string publicKey, uint256 timestamp);
    event DIDUpdated(address indexed owner, string publicKey, uint256 timestamp);
    event DIDRevoked(address indexed owner, uint256 timestamp);

    // Errori Custom (risparmiano molto gas rispetto ai classici 'require' con stringhe)
    error AlreadyRegistered(address owner);
    error NotRegistered(address owner);
    error DIDInactive(address owner);
    error DIDAlreadyTaken(string did);
    error InvalidDID();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // Inizializzazione del Proxy
    function initialize(address initialOwner) initializer public {
        __Ownable_init(initialOwner);
    }

    // 1. REGISTRAZIONE DELL'IDENTITÀ
    function registerDID(
        string calldata did,
        string calldata publicKey,
        string calldata serviceEndpoint
    ) external {
        if (_registered[msg.sender]) revert AlreadyRegistered(msg.sender);
        if (bytes(did).length == 0) revert InvalidDID();
        if (_didToOwner[did] != address(0)) revert DIDAlreadyTaken(did);

        _documents[msg.sender] = DIDDocument({
            owner: msg.sender,
            publicKey: publicKey,
            serviceEndpoint: serviceEndpoint,
            createdAt: block.timestamp,
            updatedAt: block.timestamp,
            active: true
        });

        _registered[msg.sender] = true;
        _didToOwner[did] = msg.sender;

        emit DIDRegistered(msg.sender, did, publicKey, block.timestamp);
    }

    // 2. RISOLUZIONE DEL DID (Chiama questa funzione per ottenere la chiave pubblica di una banca/autorità)
    function resolveDID(string calldata did) external view returns (DIDDocument memory) {
        address owner = _didToOwner[did];
        if (owner == address(0)) revert NotRegistered(owner);
        return _documents[owner];
    }

    // 3. AGGIORNAMENTO DELLE CHIAVI
    function updateDID(
        string calldata newPublicKey,
        string calldata newServiceEndpoint
    ) external {
        if (!_registered[msg.sender]) revert NotRegistered(msg.sender);
        if (!_documents[msg.sender].active) revert DIDInactive(msg.sender);

        if (bytes(newPublicKey).length > 0) {
            _documents[msg.sender].publicKey = newPublicKey;
        }
        if (bytes(newServiceEndpoint).length > 0) {
            _documents[msg.sender].serviceEndpoint = newServiceEndpoint;
        }

        _documents[msg.sender].updatedAt = block.timestamp;
        emit DIDUpdated(msg.sender, _documents[msg.sender].publicKey, block.timestamp);
    }

    // 4. DISATTIVAZIONE
    function revokeDID() external {
        if (!_registered[msg.sender]) revert NotRegistered(msg.sender);
        if (!_documents[msg.sender].active) revert DIDInactive(msg.sender);

        _documents[msg.sender].active = false;
        emit DIDRevoked(msg.sender, block.timestamp);
    }

    // Helper per verificare se un'identità è operativa
    function isActive(string calldata did) external view returns (bool) {
        address owner = _didToOwner[did];
        return _registered[owner] && _documents[owner].active;
    }

    // Autorizzazione per l'aggiornamento del contratto (UUPS)
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}