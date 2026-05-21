// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract PolicyManager is Initializable, OwnableUpgradeable, UUPSUpgradeable {

    error AccessDeniedNotAuthority();
    error ProposalAlreadyExecuted();
    error AlreadyVoted();
    error TimelockNotExpired();
    error ProposalNotReady();
    error UpgradeAlreadyExecuted();
    error UnanimityRequired();
    error UpgradeTimelockNotExpired();
    error InvalidTarget();

    // Numero di autorità Core nel Consorzio (UIF, AdE, GdF)
    uint256 public constant CORE_AUTHORITY_COUNT = 3;

    // Attesa obbligatoria dopo il quorum prima dell'esecuzione
    uint256 public constant TIMELOCK_DURATION = 48 hours;
    uint256 public constant UPGRADE_TIMELOCK_DURATION = 48 hours;

    // Governance Token (Soulbound NFT) usato per verificare il diritto di voto
    IERC721 public governanceToken;

    // Proposta di onboarding banca: quorum 2/3 + Timelock 48h
    struct Proposal {
        address subjectBank;
        uint256 votes;
        bool executed;
        uint256 quorumReachedAt; // 0 finché il quorum non è raggiunto
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    // Proposta di upgrade UUPS: unanimità 3/3 + Timelock 48h
    struct UpgradeProposal {
        address targetProxy;
        address newImplementation;
        uint256 votes;
        bool executed;
        uint256 quorumReachedAt; // 0 finché l'unanimità non è raggiunta
    }

    uint256 public upgradeProposalCount;
    mapping(uint256 => UpgradeProposal) public upgradeProposals;
    mapping(uint256 => mapping(address => bool)) public hasVotedUpgrade;

    event ProposalCreated(uint256 indexed id, address subjectBank);
    event Voted(uint256 indexed id, address voter);
    event QuorumReached(uint256 indexed id, uint256 executableAfter);
    event BankOnboarded(address subjectBank);

    event UpgradeProposed(uint256 indexed id, address targetProxy, address newImplementation);
    event UpgradeVoted(uint256 indexed id, address voter);
    event UpgradeUnanimityReached(uint256 indexed id, uint256 executableAfter);
    event UpgradeExecuted(uint256 indexed id, address targetProxy, address newImplementation);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner, address _governanceTokenAddress) initializer public {
        __Ownable_init(initialOwner);
        governanceToken = IERC721(_governanceTokenAddress);
    }

    // Solo i detentori di un Governance Token (UIF, AdE, GdF) possono agire
    modifier onlyAuthority() {
        if (governanceToken.balanceOf(msg.sender) == 0) revert AccessDeniedNotAuthority();
        _;
    }

    // Propone l'ingresso di una nuova banca. Chi propone vota automaticamente.
    function proposeBankOnboarding(address bank) external onlyAuthority {
        uint256 id = proposalCount++;
        proposals[id].subjectBank = bank;
        emit ProposalCreated(id, bank);
        _vote(id, msg.sender);
    }

    // Le altre autorità votano a favore della proposta.
    function vote(uint256 proposalId) external onlyAuthority {
        _vote(proposalId, msg.sender);
    }

    // Esegue la proposta dopo il Timelock di 48h dal quorum. Permissionless.
    function executeProposal(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.quorumReachedAt == 0) revert ProposalNotReady();
        if (block.timestamp < p.quorumReachedAt + TIMELOCK_DURATION) revert TimelockNotExpired();

        p.executed = true;
        emit BankOnboarded(p.subjectBank);
        // In produzione: emissione automatica della VC nel CredentialRegistry
    }

    // Registra il voto. Al quorum 2/3 avvia il Timelock senza eseguire.
    function _vote(uint256 proposalId, address voter) internal {
        Proposal storage p = proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (hasVoted[proposalId][voter]) revert AlreadyVoted();

        hasVoted[proposalId][voter] = true;
        p.votes += 1;
        emit Voted(proposalId, voter);

        if (p.votes >= 2 && p.quorumReachedAt == 0) {
            p.quorumReachedAt = block.timestamp;
            emit QuorumReached(proposalId, block.timestamp + TIMELOCK_DURATION);
        }
    }

    // Propone un upgrade UUPS. Richiede unanimità 3/3 + Timelock 48h.
    function proposeUpgrade(address targetProxy, address newImplementation) external onlyAuthority {
        if (targetProxy == address(0) || newImplementation == address(0)) revert InvalidTarget();

        uint256 id = upgradeProposalCount++;
        upgradeProposals[id] = UpgradeProposal({
            targetProxy: targetProxy,
            newImplementation: newImplementation,
            votes: 0,
            executed: false,
            quorumReachedAt: 0
        });

        emit UpgradeProposed(id, targetProxy, newImplementation);
        _voteUpgrade(id, msg.sender);
    }

    // Le altre autorità votano a favore dell'upgrade.
    function voteUpgrade(uint256 upgradeId) external onlyAuthority {
        _voteUpgrade(upgradeId, msg.sender);
    }

    // Esegue l'upgrade dopo unanimità + Timelock. Chiama upgradeToAndCall sul proxy target.
    function executeUpgrade(uint256 upgradeId) external onlyAuthority {
        UpgradeProposal storage up = upgradeProposals[upgradeId];
        if (up.executed) revert UpgradeAlreadyExecuted();
        if (up.votes < CORE_AUTHORITY_COUNT) revert UnanimityRequired();
        if (up.quorumReachedAt == 0) revert ProposalNotReady();
        if (block.timestamp < up.quorumReachedAt + UPGRADE_TIMELOCK_DURATION) revert UpgradeTimelockNotExpired();

        up.executed = true;
        IUUPSUpgradeable(up.targetProxy).upgradeToAndCall(up.newImplementation, "");
        emit UpgradeExecuted(upgradeId, up.targetProxy, up.newImplementation);
    }

    // Registra il voto sull'upgrade. All'unanimità 3/3 avvia il Timelock.
    function _voteUpgrade(uint256 upgradeId, address voter) internal {
        UpgradeProposal storage up = upgradeProposals[upgradeId];
        if (up.executed) revert UpgradeAlreadyExecuted();
        if (hasVotedUpgrade[upgradeId][voter]) revert AlreadyVoted();

        hasVotedUpgrade[upgradeId][voter] = true;
        up.votes += 1;
        emit UpgradeVoted(upgradeId, voter);

        if (up.votes >= CORE_AUTHORITY_COUNT && up.quorumReachedAt == 0) {
            up.quorumReachedAt = block.timestamp;
            emit UpgradeUnanimityReached(upgradeId, block.timestamp + UPGRADE_TIMELOCK_DURATION);
        }
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}

// Interfaccia minimale per invocare upgradeToAndCall sui proxy UUPS target
interface IUUPSUpgradeable {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}
