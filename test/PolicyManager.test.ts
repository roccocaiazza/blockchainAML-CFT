import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("Suite di Test: Modulo di Governance e Policy Manager", function () {

    // Fixture: Configura l'ambiente pulito prima di ogni test per evitare sovrapposizioni di stato
    async function deployFrameworkFixture() {
        const [deployer, uif, ade, gdf, bank, unauthorizedUser] = await ethers.getSigners();

        // Deployment Governance Token
        const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
        const governance = (await upgrades.deployProxy(GovernanceToken, [deployer.address], { kind: 'uups' })) as any;
        await governance.waitForDeployment();

        // Assegnazione SBT alle Autorita'
        await governance.mint(uif.address);
        await governance.mint(ade.address);
        await governance.mint(gdf.address);

        // Deployment Policy Manager
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

            // L'utente non autorizzato non deve possedere token di governance
            expect(await governance.balanceOf(unauthorizedUser.address)).to.equal(0);
        });
    });

    describe("Fase 2: Sistema di Voto e Quorum (Onboarding Banca)", function () {

        it("Dovrebbe permettere a un'Autorita' di proporre l'ingresso di una nuova banca", async function () {
            const { policyManager, uif, bank } = await loadFixture(deployFrameworkFixture);

            await expect(policyManager.connect(uif).proposeBankOnboarding(bank.address))
                .to.emit(policyManager, "ProposalCreated")
                .withArgs(0, bank.address)
                .and.to.emit(policyManager, "Voted")
                .withArgs(0, uif.address); // Il proponente vota automaticamente a favore
        });

        it("Dovrebbe negare categoricamente la proposta se effettuata da un utente non autorizzato", async function () {
            const { policyManager, unauthorizedUser, bank } = await loadFixture(deployFrameworkFixture);

            await expect(policyManager.connect(unauthorizedUser).proposeBankOnboarding(bank.address))
                .to.be.revertedWith("Accesso Negato: Non sei un'Autorita'");
        });

        it("Dovrebbe raggiungere il quorum (2 su 3) ed eseguire l'approvazione istituzionale", async function () {
            const { policyManager, uif, ade, bank } = await loadFixture(deployFrameworkFixture);

            // La UIF propone (1 voto automatico)
            await policyManager.connect(uif).proposeBankOnboarding(bank.address);

            // L'AdE vota a favore (2 voti -> Raggiungimento Quorum)
            await expect(policyManager.connect(ade).vote(0))
                .to.emit(policyManager, "BankOnboarded")
                .withArgs(bank.address);

            const proposal = await policyManager.proposals(0);
            expect(proposal.executed).to.be.true;
            expect(proposal.votes).to.equal(2);
        });

        it("Dovrebbe impedire matematicamente il doppio voto da parte della medesima Autorita'", async function () {
            const { policyManager, uif, bank } = await loadFixture(deployFrameworkFixture);

            // La UIF propone (1 voto automatico registrato)
            await policyManager.connect(uif).proposeBankOnboarding(bank.address);

            // La UIF tenta di forzare un secondo voto sulla medesima proposta
            await expect(policyManager.connect(uif).vote(0))
                .to.be.revertedWith("Hai gia' votato per questa proposta");
        });
    });
});