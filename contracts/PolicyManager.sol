// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
// Interfaccia standard per interagire con il tuo Governance Token
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract PolicyManager is Initializable, OwnableUpgradeable, UUPSUpgradeable {

    // Riferimento al contratto GovernanceToken
    IERC721 public governanceToken;

    struct Proposal {
        address subjectBank; // La banca che vuole entrare nel network
        uint256 votes;       // Numero di voti ricevuti
        bool executed;       // Se la proposta e' passata
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;

    // Mappatura nidificata per evitare doppi voti: proposalId => (voterAddress => haVotato?)
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event ProposalCreated(uint256 indexed id, address subjectBank);
    event Voted(uint256 indexed id, address voter);
    event BankOnboarded(address subjectBank);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // Nell'inizializzazione passiamo l'indirizzo del GovernanceToken
    function initialize(address initialOwner, address _governanceTokenAddress) initializer public {
        __Ownable_init(initialOwner);
        governanceToken = IERC721(_governanceTokenAddress);
    }

    // Modificatore: controlla che chi chiama la funzione possieda almeno 1 Governance Token
    modifier onlyAuthority() {
        require(governanceToken.balanceOf(msg.sender) > 0, "Accesso Negato: Non sei un'Autorita'");
        _;
    }

    // Proponi l'ingresso di una nuova banca
    function proposeBankOnboarding(address bank) external onlyAuthority {
        uint256 id = proposalCount++;

        Proposal storage p = proposals[id];
        p.subjectBank = bank;

        emit ProposalCreated(id, bank);

        // Chi propone vota automaticamente a favore
        _vote(id, msg.sender);
    }

    // Le altre autorita' votano
    function vote(uint256 proposalId) external onlyAuthority {
        _vote(proposalId, msg.sender);
    }

    // Logica interna di voto
    function _vote(uint256 proposalId, address voter) internal {
        Proposal storage p = proposals[proposalId];

        require(!p.executed, "Proposta gia' eseguita");
        require(!hasVoted[proposalId][voter], "Hai gia' votato per questa proposta");

        hasVoted[proposalId][voter] = true;
        p.votes += 1;

        emit Voted(proposalId, voter);

        // CONTROLLO QUORUM: 2 voti su 3 bastano per far entrare la banca
        if (p.votes >= 2) {
            p.executed = true;
            emit BankOnboarded(p.subjectBank);
            // In un sistema di produzione, qui il contratto potrebbe emettere automaticamente
            // la credenziale nel CredentialRegistry. Per semplicita', lo gestiamo via eventi.
        }
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}