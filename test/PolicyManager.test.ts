import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("Suite di Test: Modulo di Governance e Policy Manager", function () {

    async function deployFrameworkFixture() {
        const [deployer, uif, ade, gdf, bank, unauthorizedUser] = await ethers.getSigners();

        const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
        const governance = (await upgrades.deployProxy(GovernanceToken, [deployer.address], { kind: 'uups' })) as any;
        await governance.waitForDeployment();

        await governance.mint(uif.address);
        await governance.mint(ade.address);
        await governance.mint(gdf.address);

        const PolicyManager = await ethers.getContractFactory("PolicyManager");
        const policyManager = (await upgrades.deployProxy(PolicyManager, [deployer.address, await governance.getAddress()], { kind: 'uups' })) as any;
        await policyManager.waitForDeployment();

        return { governance, policyManager, deployer, uif, ade, gdf, bank, unauthorizedUser };
    }

    describe("Fase 1: Verifica Configurazione Iniziale", function () {

        it("Dovrebbe assegnare correttamente i Soulbound Token (SBT) alle Autorita' designate", async function () {
            const { governance, uif, ade, gdf, unauthorizedUser } = await loadFixture(deployFrameworkFixture);

            expect(await governance.balanceOf(uif.address)).to.equal(1);
            expect(await governance.balanceOf(ade.address)).to.equal(1);
            expect(await governance.balanceOf(gdf.address)).to.equal(1);
            expect(await governance.balanceOf(unauthorizedUser.address)).to.equal(0);
        });
    });

    describe("Fase 2: Membership Policy — Quorum 2/3 + Timelock 48h", function () {

        it("Dovrebbe permettere a un'Autorita' di proporre l'ingresso di una nuova banca", async function () {
            const { policyManager, uif, bank } = await loadFixture(deployFrameworkFixture);

            await expect(policyManager.connect(uif).proposeBankOnboarding(bank.address))
                .to.emit(policyManager, "ProposalCreated").withArgs(0, bank.address)
                .and.to.emit(policyManager, "Voted").withArgs(0, uif.address);
        });

        it("Dovrebbe negare la proposta a un utente non autorizzato", async function () {
            const { policyManager, unauthorizedUser, bank } = await loadFixture(deployFrameworkFixture);

            await expect(policyManager.connect(unauthorizedUser).proposeBankOnboarding(bank.address))
                .to.be.revertedWithCustomError(policyManager, "AccessDeniedNotAuthority");
        });

        it("Dovrebbe raggiungere il quorum (2/3) e avviare il Timelock senza eseguire immediatamente", async function () {
            const { policyManager, uif, ade, bank } = await loadFixture(deployFrameworkFixture);

            await policyManager.connect(uif).proposeBankOnboarding(bank.address);

            // Il secondo voto raggiunge il quorum → emette QuorumReached, NON BankOnboarded
            const timelockEnd = (await time.latest()) + 1 + 48 * 3600;
            await expect(policyManager.connect(ade).vote(0))
                .to.emit(policyManager, "QuorumReached")
                .and.not.to.emit(policyManager, "BankOnboarded");

            const proposal = await policyManager.proposals(0);
            expect(proposal.executed).to.be.false;
            expect(proposal.votes).to.equal(2);
            expect(proposal.quorumReachedAt).to.be.gt(0);
        });

        it("Dovrebbe bloccare l'esecuzione prima della scadenza del Timelock", async function () {
            const { policyManager, uif, ade } = await loadFixture(deployFrameworkFixture);

            await policyManager.connect(uif).proposeBankOnboarding(ethers.Wallet.createRandom().address);
            await policyManager.connect(ade).vote(0);

            // Avanza solo 24h (meno delle 48h richieste)
            await time.increase(24 * 3600);

            await expect(policyManager.executeProposal(0))
                .to.be.revertedWithCustomError(policyManager, "TimelockNotExpired");
        });

        it("Dovrebbe eseguire la proposta dopo la scadenza del Timelock (48h)", async function () {
            const { policyManager, uif, ade, bank } = await loadFixture(deployFrameworkFixture);

            await policyManager.connect(uif).proposeBankOnboarding(bank.address);
            await policyManager.connect(ade).vote(0);

            // Avanza 48h + 1 secondo
            await time.increase(48 * 3600 + 1);

            await expect(policyManager.executeProposal(0))
                .to.emit(policyManager, "BankOnboarded").withArgs(bank.address);

            const proposal = await policyManager.proposals(0);
            expect(proposal.executed).to.be.true;
        });

        it("Dovrebbe impedire il doppio voto da parte della medesima Autorita'", async function () {
            const { policyManager, uif, bank } = await loadFixture(deployFrameworkFixture);

            await policyManager.connect(uif).proposeBankOnboarding(bank.address);

            await expect(policyManager.connect(uif).vote(0))
                .to.be.revertedWithCustomError(policyManager, "AlreadyVoted");
        });
    });

    describe("Fase 3: System Upgrade Policy — Unanimita' 3/3 + Timelock 48h", function () {

        it("Dovrebbe permettere di proporre un upgrade e raccogliere i voti", async function () {
            const { policyManager, uif, ade, gdf } = await loadFixture(deployFrameworkFixture);

            const mockProxy = ethers.Wallet.createRandom().address;
            const mockImpl = ethers.Wallet.createRandom().address;

            await expect(policyManager.connect(uif).proposeUpgrade(mockProxy, mockImpl))
                .to.emit(policyManager, "UpgradeProposed").withArgs(0, mockProxy, mockImpl)
                .and.to.emit(policyManager, "UpgradeVoted").withArgs(0, uif.address);

            await expect(policyManager.connect(ade).voteUpgrade(0))
                .to.emit(policyManager, "UpgradeVoted").withArgs(0, ade.address);

            // Il terzo voto raggiunge l'unanimità → emette UpgradeUnanimityReached
            await expect(policyManager.connect(gdf).voteUpgrade(0))
                .to.emit(policyManager, "UpgradeUnanimityReached");

            const up = await policyManager.upgradeProposals(0);
            expect(up.votes).to.equal(3);
            expect(up.quorumReachedAt).to.be.gt(0);
            expect(up.executed).to.be.false;
        });

        it("Dovrebbe bloccare l'upgrade se non si raggiunge l'unanimita' (2/3 non basta)", async function () {
            const { policyManager, uif, ade } = await loadFixture(deployFrameworkFixture);

            const mockProxy = ethers.Wallet.createRandom().address;
            const mockImpl = ethers.Wallet.createRandom().address;

            await policyManager.connect(uif).proposeUpgrade(mockProxy, mockImpl);
            await policyManager.connect(ade).voteUpgrade(0);

            // Solo 2 voti: il Timelock non è ancora partito
            const up = await policyManager.upgradeProposals(0);
            expect(up.quorumReachedAt).to.equal(0);

            await time.increase(48 * 3600 + 1);

            await expect(policyManager.connect(uif).executeUpgrade(0))
                .to.be.revertedWithCustomError(policyManager, "UnanimityRequired");
        });

        it("Dovrebbe bloccare l'upgrade prima della scadenza del Timelock", async function () {
            const { policyManager, uif, ade, gdf } = await loadFixture(deployFrameworkFixture);

            const mockProxy = ethers.Wallet.createRandom().address;
            const mockImpl = ethers.Wallet.createRandom().address;

            await policyManager.connect(uif).proposeUpgrade(mockProxy, mockImpl);
            await policyManager.connect(ade).voteUpgrade(0);
            await policyManager.connect(gdf).voteUpgrade(0);

            // Avanza solo 24h
            await time.increase(24 * 3600);

            await expect(policyManager.connect(uif).executeUpgrade(0))
                .to.be.revertedWithCustomError(policyManager, "UpgradeTimelockNotExpired");
        });

        it("Dovrebbe impedire il doppio voto sull'upgrade", async function () {
            const { policyManager, uif } = await loadFixture(deployFrameworkFixture);

            const mockProxy = ethers.Wallet.createRandom().address;
            const mockImpl = ethers.Wallet.createRandom().address;

            await policyManager.connect(uif).proposeUpgrade(mockProxy, mockImpl);

            await expect(policyManager.connect(uif).voteUpgrade(0))
                .to.be.revertedWithCustomError(policyManager, "AlreadyVoted");
        });
    });
});
