// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract GovernanceToken is Initializable, ERC721Upgradeable, OwnableUpgradeable, UUPSUpgradeable {

    error AlreadyHasToken();
    error SoulboundTransferBlocked();

    uint256 private _nextTokenId;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) initializer public {
        __ERC721_init("AML Governance Token", "AMLG");
        __Ownable_init(initialOwner);
        _nextTokenId = 1;
    }

    // Minta un token a un'autorità. Solo il deployer può farlo. Un indirizzo può averne al massimo uno.
    function mint(address to) public onlyOwner {
        if(balanceOf(to) > 0) revert AlreadyHasToken();
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
    }

    // Blocca qualsiasi trasferimento (Soulbound). Permette solo minting e burning.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            revert SoulboundTransferBlocked();
        }
        return super._update(to, tokenId, auth);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
