// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract CredentialRegistry is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    
    error CredentialAlreadyExists();
    error CredentialNotFound();
    error UnauthorizedRevoke();
    error AlreadyRevoked();

    struct Credential {
        address issuer;          // Chi ha emesso la credenziale (es. UIF)
        address subject;         // Chi la riceve (es. Banca)
        bytes32 credentialHash;  // L'hash del documento JSON off-chain
        uint256 issuedAt;
        bool revoked;
    }

    // Mappatura per trovare una credenziale dal suo ID univoco
    mapping(bytes32 => Credential) private credentials;

    event CredentialIssued(bytes32 indexed credId, address issuer, address subject);
    event CredentialRevoked(bytes32 indexed credId);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) initializer public {
        __Ownable_init(initialOwner);
    }

    // Emette una nuova credenziale
    function issueCredential(
        bytes32 credId,
        address subject,
        bytes32 credentialHash
    ) external {
        if(credentials[credId].issuedAt != 0) revert CredentialAlreadyExists();

        credentials[credId] = Credential({
            issuer: msg.sender,
            subject: subject,
            credentialHash: credentialHash,
            issuedAt: block.timestamp,
            revoked: false
        });

        emit CredentialIssued(credId, msg.sender, subject);
    }

    // Legge una credenziale
    function getCredential(bytes32 credId) external view returns (Credential memory) {
        if(credentials[credId].issuedAt == 0) revert CredentialNotFound();
        return credentials[credId];
    }

    // Revoca una credenziale (solo l'emittente puo' farlo)
    function revokeCredential(bytes32 credId) external {
        Credential storage cred = credentials[credId];
        if(cred.issuedAt == 0) revert CredentialNotFound();
        if(cred.issuer != msg.sender) revert UnauthorizedRevoke();
        if(cred.revoked) revert AlreadyRevoked();

        cred.revoked = true;
        emit CredentialRevoked(credId);
    }

    // Verifica lo stato di validita'
    function verifyCredential(bytes32 credId) external view returns (bool) {
        Credential memory cred = credentials[credId];
        return cred.issuedAt != 0 && !cred.revoked;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}