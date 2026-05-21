// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract DIDRegistry is Initializable, OwnableUpgradeable, UUPSUpgradeable {

    struct DIDDocument {
        address owner;
        bytes publicKey;       // Chiave pubblica RSA usata per le Buste Digitali
        bytes serviceEndpoint; // URL del nodo off-chain dell'ente
        uint256 createdAt;
        uint256 updatedAt;
        bool active;
    }

    mapping(address => DIDDocument) private _documents;
    mapping(address => bool) private _registered;
    mapping(bytes32 => address) private _didToOwner;

    event DIDRegistered(address indexed owner, bytes32 indexed did, bytes publicKey, uint256 timestamp);
    event DIDUpdated(address indexed owner, bytes publicKey, uint256 timestamp);
    event DIDRevoked(address indexed owner, uint256 timestamp);

    error AlreadyRegistered(address owner);
    error NotRegistered(address owner);
    error DIDInactive(address owner);
    error DIDAlreadyTaken(bytes32 did);
    error InvalidDID();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) initializer public {
        __Ownable_init(initialOwner);
    }

    // Registra un nuovo DID con chiave pubblica e service endpoint.
    function registerDID(
        bytes32 did,
        bytes calldata publicKey,
        bytes calldata serviceEndpoint
    ) external {
        if (_registered[msg.sender]) revert AlreadyRegistered(msg.sender);
        if (did == bytes32(0)) revert InvalidDID();
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

    // Restituisce il DIDDocument associato a un DID, inclusa la chiave pubblica RSA.
    function resolveDID(bytes32 did) external view returns (DIDDocument memory) {
        address owner = _didToOwner[did];
        if (owner == address(0)) revert NotRegistered(owner);
        return _documents[owner];
    }

    // Aggiorna la chiave pubblica o il service endpoint del proprio DID.
    function updateDID(
        bytes calldata newPublicKey,
        bytes calldata newServiceEndpoint
    ) external {
        if (!_registered[msg.sender]) revert NotRegistered(msg.sender);
        if (!_documents[msg.sender].active) revert DIDInactive(msg.sender);

        if (newPublicKey.length > 0) {
            _documents[msg.sender].publicKey = newPublicKey;
        }
        if (newServiceEndpoint.length > 0) {
            _documents[msg.sender].serviceEndpoint = newServiceEndpoint;
        }

        _documents[msg.sender].updatedAt = block.timestamp;
        emit DIDUpdated(msg.sender, _documents[msg.sender].publicKey, block.timestamp);
    }

    // Disattiva il DID. Operazione irreversibile.
    function revokeDID() external {
        if (!_registered[msg.sender]) revert NotRegistered(msg.sender);
        if (!_documents[msg.sender].active) revert DIDInactive(msg.sender);

        _documents[msg.sender].active = false;
        emit DIDRevoked(msg.sender, block.timestamp);
    }

    // Restituisce true se il DID è registrato e attivo.
    function isActive(bytes32 did) external view returns (bool) {
        address owner = _didToOwner[did];
        return _registered[owner] && _documents[owner].active;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
