import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("Suite di Test: Access Control e Deleghe Temporanee (DelegationManager)", function () {

    // Fixture: Configura l'ambiente e crea un dossier di base per i test
    async function deployDelegationFixture() {
        const [deployer, uif, ade, bank, uifProvinciale, unauthorizedUser] = await ethers.getSigners();

        // Deployment Dipendenze
        const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
        const credRegistry = (await upgrades.deployProxy(CredentialRegistry, [deployer.address], { kind: 'uups' })) as any;

        const DocumentRegistry = await ethers.getContractFactory("DocumentRegistry");
        const docRegistry = (await upgrades.deployProxy(DocumentRegistry, [deployer.address, await credRegistry.getAddress()], { kind: 'uups' })) as any;

        const DelegationManager = await ethers.getContractFactory("DelegationManager");
        const delegationManager = (await upgrades.deployProxy(DelegationManager, [deployer.address, await docRegistry.getAddress()], { kind: 'uups' })) as any;

        // Setup dello Stato Iniziale: Creazione di un Dossier assegnato alla UIF
        const bankCredId = ethers.id("VC-AUTH-BANCA");
        await credRegistry.issueCredential(bankCredId, bank.address, ethers.id("HASH"));

        const dossierId = ethers.id("DOSSIER-TEST-DELEGA");
        await docRegistry.connect(bank).submitDossier(
            dossierId, bankCredId, uif.address, "ipfs://iniziale", "0xbusta"
        );

        return {
            delegationManager, docRegistry, uif, ade, bank, uifProvinciale, unauthorizedUser, dossierId
        };
    }

    describe("Fase 1: Creazione Delega e Verifica Accessi", function () {

        it("Dovrebbe permettere al gestore corrente (UIF) di delegare un ufficio periferico", async function () {
            const { delegationManager, uif, uifProvinciale, dossierId } = await loadFixture(deployDelegationFixture);

            const delegationId = ethers.id("DELEGA-001");
            const ttl = 3600; // 1 ora
            const parentDelegationId = ethers.zeroPadValue("0x", 32); // Delega radice

            await expect(delegationManager.connect(uif).delegateAccess(
                delegationId, dossierId, uifProvinciale.address, ttl, parentDelegationId
            )).to.emit(delegationManager, "AccessDelegated")
                .withArgs(delegationId, dossierId, uif.address, uifProvinciale.address);

            // Verifica dell'accesso immediato
            const hasAccess = await delegationManager.checkAccess(delegationId, uifProvinciale.address, dossierId);
            expect(hasAccess).to.be.true;
        });

        it("Dovrebbe impedire a un ente non in carico (AdE) di delegare il dossier della UIF", async function () {
            const { delegationManager, ade, uifProvinciale, dossierId } = await loadFixture(deployDelegationFixture);

            const delegationId = ethers.id("DELEGA-002");
            const ttl = 3600;

            await expect(delegationManager.connect(ade).delegateAccess(
                delegationId, dossierId, uifProvinciale.address, ttl, ethers.zeroPadValue("0x", 32)
            )).to.be.revertedWith("Errore di Accesso: Non hai i permessi per delegare questo dossier");
        });
    });

    describe("Fase 2: Time-To-Live (TTL) e Lazy Revocation", function () {

        it("Dovrebbe revocare automaticamente l'accesso allo scadere del TTL (Lazy Revocation)", async function () {
            const { delegationManager, uif, uifProvinciale, dossierId } = await loadFixture(deployDelegationFixture);

            const delegationId = ethers.id("DELEGA-TTL-TEST");
            const ttl = 86400; // 24 ore

            await delegationManager.connect(uif).delegateAccess(
                delegationId, dossierId, uifProvinciale.address, ttl, ethers.zeroPadValue("0x", 32)
            );

            // Verifica accesso valido
            expect(await delegationManager.checkAccess(delegationId, uifProvinciale.address, dossierId)).to.be.true;

            // Manipolazione temporale: Avanziamo l'orologio della blockchain di 25 ore
            await time.increase(86400 + 3600);

            // L'accesso deve ora risultare falso senza alcun intervento manuale
            expect(await delegationManager.checkAccess(delegationId, uifProvinciale.address, dossierId)).to.be.false;
        });

        it("Dovrebbe permettere la revoca manuale immediata da parte del delegante", async function () {
            const { delegationManager, uif, uifProvinciale, dossierId } = await loadFixture(deployDelegationFixture);

            const delegationId = ethers.id("DELEGA-REVOCA-MANUALE");
            await delegationManager.connect(uif).delegateAccess(
                delegationId, dossierId, uifProvinciale.address, 3600, ethers.zeroPadValue("0x", 32)
            );

            // La UIF revoca manualmente la delega prima della scadenza
            await expect(delegationManager.connect(uif).revokeDelegation(delegationId))
                .to.emit(delegationManager, "DelegationRevoked")
                .withArgs(delegationId);

            // L'accesso deve risultare immediatamente falso
            expect(await delegationManager.checkAccess(delegationId, uifProvinciale.address, dossierId)).to.be.false;
        });
    });

    describe("Fase 3: Gestione Anomalie (Dispute)", function () {

        it("Dovrebbe permettere al gestore di segnalare una disputa crittografica", async function () {
            const { delegationManager, uif, dossierId } = await loadFixture(deployDelegationFixture);

            await expect(delegationManager.connect(uif).logDispute(dossierId, "Chiave DEK compromessa"))
                .to.emit(delegationManager, "DisputeLogged")
                .withArgs(dossierId, uif.address, "Chiave DEK compromessa");

            expect(await delegationManager.activeDisputes(dossierId)).to.be.true;
        });

        it("Dovrebbe impedire a un utente non autorizzato di aprire una disputa", async function () {
            const { delegationManager, unauthorizedUser, dossierId } = await loadFixture(deployDelegationFixture);

            await expect(delegationManager.connect(unauthorizedUser).logDispute(dossierId, "Tentativo di frode"))
                .to.be.revertedWith("Errore: Solo il gestore puo' aprire una disputa su questo dossier");
        });
    });
});