// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract GovernanceToken is Initializable, ERC721Upgradeable, OwnableUpgradeable, UUPSUpgradeable {
    
    error AlreadyHasToken();
    error SoulboundTransferBlocked();

    // Variabile di stato per tenere traccia dell'ID del prossimo token
    uint256 private _nextTokenId;

    /// @custom:oz-upgrades-unsafe-allow constructor
    // Blocca l'inizializzazione del contratto logico per ragioni di sicurezza (best practice UUPS)
    constructor() {
        _disableInitializers();
    }

    // Al posto del costruttore tradizionale, usiamo initialize()
    function initialize(address initialOwner) initializer public {
        // Inizializza il nome e il simbolo dell'NFT
        __ERC721_init("AML Governance Token", "AMLG");
        __Ownable_init(initialOwner);
        
        _nextTokenId = 1; // Partiamo dal token ID 1
    }

    // FUNZIONE DI MINTING
    // Solo il Super-Admin (Deployer) può chiamarla durante la fase di "Big Bang"
    function mint(address to) public onlyOwner {
        if(balanceOf(to) > 0) revert AlreadyHasToken();
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
    }

    // LOGICA SOULBOUND (NON TRASFERIBILE)
    // Sovrascriviamo la funzione interna _update di OpenZeppelin (versione 5)
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        
        // Se 'from' non è zero (non è un minting) e 'to' non è zero (non è un burning),
        // allora qualcuno sta cercando di trasferire il token. Lo blocchiamo!
        if (from != address(0) && to != address(0)) {
            revert SoulboundTransferBlocked();
        }

        return super._update(to, tokenId, auth);
    }

    // AUTORIZZAZIONE AGGIORNAMENTI (UUPS)
    // Solo l'owner attuale può aggiornare il codice del contratto in futuro
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}