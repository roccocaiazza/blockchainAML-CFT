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

    // -------------------------------------------------------------------------
    // COSTANTI DI GOVERNANCE
    // -------------------------------------------------------------------------

    /// @dev Numero totale di autorità Core nel Consorzio (UIF + AdE + GdF)
    uint256 public constant CORE_AUTHORITY_COUNT = 3;

    /// @dev Finestra di attesa obbligatoria dopo il raggiungimento del quorum 2/3
    ///      prima che una proposta ordinaria possa essere eseguita (48 ore)
    uint256 public constant TIMELOCK_DURATION = 48 hours;

    /// @dev Finestra di attesa per le proposte di upgrade (più lunga per maggiore sicurezza)
    uint256 public constant UPGRADE_TIMELOCK_DURATION = 48 hours;

    // -------------------------------------------------------------------------
    // STATO
    // -------------------------------------------------------------------------

    /// @dev Riferimento al contratto GovernanceToken (Soulbound NFT)
    IERC721 public governanceToken;

    // --- Membership Policy (onboarding banche, quorum 2/3 + Timelock 48h) ---

    struct Proposal {
        address subjectBank;      // La banca candidata all'ingresso nel network
        uint256 votes;            // Voti favorevoli accumulati
        bool executed;            // True se la proposta è già stata eseguita
        uint256 quorumReachedAt;  // Timestamp in cui è stato raggiunto il quorum (0 = non ancora)
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    // --- System Upgrade Policy (upgrade UUPS, unanimità 3/3 + Timelock 48h) ---

    struct UpgradeProposal {
        address targetProxy;       // Il contratto proxy da aggiornare
        address newImplementation; // Il nuovo contratto logico
        uint256 votes;             // Voti favorevoli (deve raggiungere CORE_AUTHORITY_COUNT)
        bool executed;
        uint256 quorumReachedAt;   // Timestamp unanimità raggiunta
    }

    uint256 public upgradeProposalCount;
    mapping(uint256 => UpgradeProposal) public upgradeProposals;
    mapping(uint256 => mapping(address => bool)) public hasVotedUpgrade;

    // -------------------------------------------------------------------------
    // EVENTI
    // -------------------------------------------------------------------------

    event ProposalCreated(uint256 indexed id, address subjectBank);
    event Voted(uint256 indexed id, address voter);
    event QuorumReached(uint256 indexed id, uint256 executableAfter);
    event BankOnboarded(address subjectBank);

    event UpgradeProposed(uint256 indexed id, address targetProxy, address newImplementation);
    event UpgradeVoted(uint256 indexed id, address voter);
    event UpgradeUnanimityReached(uint256 indexed id, uint256 executableAfter);
    event UpgradeExecuted(uint256 indexed id, address targetProxy, address newImplementation);

    // -------------------------------------------------------------------------
    // INIZIALIZZAZIONE
    // -------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner, address _governanceTokenAddress) initializer public {
        __Ownable_init(initialOwner);
        governanceToken = IERC721(_governanceTokenAddress);
    }

    // -------------------------------------------------------------------------
    // MODIFICATORI
    // -------------------------------------------------------------------------

    /// @dev Garantisce che solo i detentori di un Governance Token (UIF, AdE, GdF) possano agire
    modifier onlyAuthority() {
        if (governanceToken.balanceOf(msg.sender) == 0) revert AccessDeniedNotAuthority();
        _;
    }

    // -------------------------------------------------------------------------
    // MEMBERSHIP POLICY — Quorum 2/3 + Timelock 48h
    // -------------------------------------------------------------------------

    /// @notice Propone l'ingresso di una nuova banca nel network.
    ///         Chi propone vota automaticamente a favore.
    function proposeBankOnboarding(address bank) external onlyAuthority {
        uint256 id = proposalCount++;
        proposals[id].subjectBank = bank;
        emit ProposalCreated(id, bank);
        _vote(id, msg.sender);
    }

    /// @notice Le altre autorità votano a favore della proposta.
    function vote(uint256 proposalId) external onlyAuthority {
        _vote(proposalId, msg.sender);
    }

    /// @notice Esegue la proposta dopo che il Timelock è scaduto.
    ///         Chiunque può chiamarla (permissionless execution), ma solo dopo 48h dal quorum.
    function executeProposal(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.quorumReachedAt == 0) revert ProposalNotReady();
        if (block.timestamp < p.quorumReachedAt + TIMELOCK_DURATION) revert TimelockNotExpired();

        p.executed = true;
        emit BankOnboarded(p.subjectBank);
        // In produzione: emissione automatica della VC nel CredentialRegistry
    }

    /// @dev Logica interna di voto. Registra il quorum ma NON esegue immediatamente.
    function _vote(uint256 proposalId, address voter) internal {
        Proposal storage p = proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (hasVoted[proposalId][voter]) revert AlreadyVoted();

        hasVoted[proposalId][voter] = true;
        p.votes += 1;
        emit Voted(proposalId, voter);

        // Al raggiungimento del quorum 2/3 si avvia il Timelock, ma NON si esegue ancora
        if (p.votes >= 2 && p.quorumReachedAt == 0) {
            p.quorumReachedAt = block.timestamp;
            emit QuorumReached(proposalId, block.timestamp + TIMELOCK_DURATION);
        }
    }

    // -------------------------------------------------------------------------
    // SYSTEM UPGRADE POLICY — Unanimità 3/3 + Timelock 48h
    // -------------------------------------------------------------------------

    /// @notice Propone un aggiornamento del codice di un contratto proxy UUPS.
    ///         Richiede unanimità (3/3) prima di poter essere eseguito.
    /// @param targetProxy       Indirizzo del contratto proxy da aggiornare
    /// @param newImplementation Indirizzo del nuovo contratto logico già deployato
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

    /// @notice Le altre autorità votano a favore dell'upgrade.
    function voteUpgrade(uint256 upgradeId) external onlyAuthority {
        _voteUpgrade(upgradeId, msg.sender);
    }

    /// @notice Esegue l'upgrade dopo unanimità + Timelock.
    ///         Chiama upgradeToAndCall sul proxy target, che verificherà onlyOwner
    ///         (il PolicyManager deve essere owner dei proxy per funzionare in produzione).
    function executeUpgrade(uint256 upgradeId) external onlyAuthority {
        UpgradeProposal storage up = upgradeProposals[upgradeId];
        if (up.executed) revert UpgradeAlreadyExecuted();
        if (up.votes < CORE_AUTHORITY_COUNT) revert UnanimityRequired();
        if (up.quorumReachedAt == 0) revert ProposalNotReady();
        if (block.timestamp < up.quorumReachedAt + UPGRADE_TIMELOCK_DURATION) revert UpgradeTimelockNotExpired();

        up.executed = true;

        // Esegue l'upgrade sul proxy target tramite l'interfaccia UUPS standard
        IUUPSUpgradeable(up.targetProxy).upgradeToAndCall(up.newImplementation, "");

        emit UpgradeExecuted(upgradeId, up.targetProxy, up.newImplementation);
    }

    /// @dev Logica interna di voto per gli upgrade.
    function _voteUpgrade(uint256 upgradeId, address voter) internal {
        UpgradeProposal storage up = upgradeProposals[upgradeId];
        if (up.executed) revert UpgradeAlreadyExecuted();
        if (hasVotedUpgrade[upgradeId][voter]) revert AlreadyVoted();

        hasVotedUpgrade[upgradeId][voter] = true;
        up.votes += 1;
        emit UpgradeVoted(upgradeId, voter);

        // Unanimità raggiunta: avvia il Timelock
        if (up.votes >= CORE_AUTHORITY_COUNT && up.quorumReachedAt == 0) {
            up.quorumReachedAt = block.timestamp;
            emit UpgradeUnanimityReached(upgradeId, block.timestamp + UPGRADE_TIMELOCK_DURATION);
        }
    }

    // -------------------------------------------------------------------------
    // UUPS
    // -------------------------------------------------------------------------

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}

/// @dev Interfaccia minimale per invocare upgradeToAndCall sui proxy UUPS target
interface IUUPSUpgradeable {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}
