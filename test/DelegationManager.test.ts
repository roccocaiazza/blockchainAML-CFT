import { expect } from "chai";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { CryptoEngine } from "../utils/crypto-utils";

describe("Suite di Test: Access Control e Deleghe Temporanee (DelegationManager)", function () {

    async function deployDelegationFixture() {
        const [deployer, uif, ade, gdf, bank, uifProvinciale, unauthorizedUser] = await ethers.getSigners();

        const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
        const credRegistry = (await upgrades.deployProxy(CredentialRegistry, [deployer.address], { kind: 'uups' })) as any;
        await credRegistry.waitForDeployment();

        // DIDRegistry necessario per la verifica DID in checkAccess
        const DIDRegistry = await ethers.getContractFactory("DIDRegistry");
        const didRegistry = (await upgrades.deployProxy(DIDRegistry, [deployer.address], { kind: 'uups' })) as any;
        await didRegistry.waitForDeployment();

        // DocumentRegistry ora richiede uif.address come terzo parametro
        const DocumentRegistry = await ethers.getContractFactory("DocumentRegistry");
        const docRegistry = (await upgrades.deployProxy(
            DocumentRegistry,
            [deployer.address, await credRegistry.getAddress(), uif.address],
            { kind: 'uups' }
        )) as any;
        await docRegistry.waitForDeployment();

        // DelegationManager inizializzato con il DIDRegistry
        const DelegationManager = await ethers.getContractFactory("DelegationManager");
        const delegationManager = (await upgrades.deployProxy(
            DelegationManager,
            [deployer.address, await docRegistry.getAddress(), [uif.address, ade.address, gdf.address], await didRegistry.getAddress()],
            { kind: 'uups' }
        )) as any;
        await delegationManager.waitForDeployment();

        // Collegamento bidirezionale per il freeze in caso di disputa
        await docRegistry.setDelegationManager(await delegationManager.getAddress()).then((tx: any) => tx.wait());

        // Setup: crea un dossier assegnato alla UIF
        const bankCredId = ethers.id("VC-AUTH-BANCA");
        await credRegistry.issueCredential(bankCredId, bank.address, ethers.id("HASH"));

        const dossierId = ethers.id("DOSSIER-TEST-DELEGA");
        const dek = CryptoEngine.generateDEK();
        const dekCommitment = CryptoEngine.computeDEKCommitment(dek);

        await docRegistry.connect(bank).submitDossier(
            dossierId, bankCredId, uif.address,
            ethers.toUtf8Bytes("ipfs://iniziale"),
            ethers.toUtf8Bytes("0xbusta"),
            dekCommitment
        );

        return {
            delegationManager, docRegistry, uif, ade, gdf, bank,
            uifProvinciale, unauthorizedUser, dossierId, dekCommitment
        };
    }

    describe("Fase 1: Creazione Delega e Verifica Accessi", function () {

        it("Dovrebbe permettere al gestore corrente (UIF) di delegare un ufficio periferico", async function () {
            const { delegationManager, uif, uifProvinciale, dossierId } = await loadFixture(deployDelegationFixture);

            const delegationId = ethers.id("DELEGA-001");
            const ttl = 3600;
            const parentDelegationId = ethers.zeroPadValue("0x", 32);

            await expect(delegationManager.connect(uif).delegateAccess(
                delegationId, dossierId, uifProvinciale.address, ttl, parentDelegationId
            )).to.emit(delegationManager, "AccessDelegated")
                .withArgs(delegationId, dossierId, uif.address, uifProvinciale.address, 0); // depth=0

            const hasAccess = await delegationManager.checkAccess(delegationId, uifProvinciale.address, dossierId);
            expect(hasAccess).to.be.true;
        });

        it("Dovrebbe impedire a un ente non in carico (AdE) di delegare il dossier della UIF", async function () {
            const { delegationManager, ade, uifProvinciale, dossierId } = await loadFixture(deployDelegationFixture);

            await expect(delegationManager.connect(ade).delegateAccess(
                ethers.id("DELEGA-002"), dossierId, uifProvinciale.address, 3600, ethers.zeroPadValue("0x", 32)
            )).to.be.revertedWithCustomError(delegationManager, "NotAuthorizedToDelegate");
        });

        it("Dovrebbe bloccare sub-deleghe oltre la profondita' massima (MAX_DELEGATION_DEPTH)", async function () {
            const { delegationManager, uif, uifProvinciale, dossierId } = await loadFixture(deployDelegationFixture);
            const [, , , , , , , peritoLivello1, peritoLivello2, peritoLivello3] = await ethers.getSigners();

            // Livello 0: UIF → uifProvinciale
            const delega0 = ethers.id("DELEGA-DEPTH-0");
            await delegationManager.connect(uif).delegateAccess(
                delega0, dossierId, uifProvinciale.address, 3600, ethers.zeroPadValue("0x", 32)
            );

            // Livello 1: uifProvinciale → peritoLivello1
            const delega1 = ethers.id("DELEGA-DEPTH-1");
            await delegationManager.connect(uifProvinciale).delegateAccess(
                delega1, dossierId, peritoLivello1.address, 3600, delega0
            );

            // Livello 2: peritoLivello1 → peritoLivello2
            const delega2 = ethers.id("DELEGA-DEPTH-2");
            await delegationManager.connect(peritoLivello1).delegateAccess(
                delega2, dossierId, peritoLivello2.address, 3600, delega1
            );

            // Livello 3: deve essere bloccato da MaxDepthExceeded
            const delega3 = ethers.id("DELEGA-DEPTH-3");
            await expect(delegationManager.connect(peritoLivello2).delegateAccess(
                delega3, dossierId, peritoLivello3.address, 3600, delega2
            )).to.be.revertedWithCustomError(delegationManager, "MaxDepthExceeded");
        });
    });

    describe("Fase 2: Time-To-Live (TTL) e Lazy Revocation", function () {

        it("Dovrebbe revocare automaticamente l'accesso allo scadere del TTL (Lazy Revocation)", async function () {
            const { delegationManager, uif, uifProvinciale, dossierId } = await loadFixture(deployDelegationFixture);

            const delegationId = ethers.id("DELEGA-TTL-TEST");
            await delegationManager.connect(uif).delegateAccess(
                delegationId, dossierId, uifProvinciale.address, 86400, ethers.zeroPadValue("0x", 32)
            );

            expect(await delegationManager.checkAccess(delegationId, uifProvinciale.address, dossierId)).to.be.true;

            await time.increase(86400 + 3600);

            expect(await delegationManager.checkAccess(delegationId, uifProvinciale.address, dossierId)).to.be.false;
        });

        it("Dovrebbe permettere la revoca manuale immediata da parte del delegante", async function () {
            const { delegationManager, uif, uifProvinciale, dossierId } = await loadFixture(deployDelegationFixture);

            const delegationId = ethers.id("DELEGA-REVOCA-MANUALE");
            await delegationManager.connect(uif).delegateAccess(
                delegationId, dossierId, uifProvinciale.address, 3600, ethers.zeroPadValue("0x", 32)
            );

            await expect(delegationManager.connect(uif).revokeDelegation(delegationId))
                .to.emit(delegationManager, "DelegationRevoked")
                .withArgs(delegationId);

            expect(await delegationManager.checkAccess(delegationId, uifProvinciale.address, dossierId)).to.be.false;
        });
    });

    describe("Fase 3: Emergency Policy (Fast-Track)", function () {

        it("Dovrebbe permettere a una Core Authority di revocare d'emergenza una propria delega", async function () {
            const { delegationManager, uif, uifProvinciale, dossierId } = await loadFixture(deployDelegationFixture);

            const delegationId = ethers.id("DELEGA-EMERGENCY-001");
            await delegationManager.connect(uif).delegateAccess(
                delegationId, dossierId, uifProvinciale.address, 86400, ethers.zeroPadValue("0x", 32)
            );

            const justification = "Perito compromesso - revoca urgente";

            // La UIF (Core Authority) revoca d'emergenza senza quorum
            await expect(delegationManager.connect(uif).emergencyRevoke(delegationId, justification))
                .to.emit(delegationManager, "DelegationRevoked").withArgs(delegationId)
                .and.to.emit(delegationManager, "EmergencyActionTaken")
                .withArgs(delegationId, uif.address, justification, anyValue);

            // L'accesso deve risultare immediatamente revocato
            expect(await delegationManager.checkAccess(delegationId, uifProvinciale.address, dossierId)).to.be.false;
        });

        it("Dovrebbe impedire a un non-Core Authority di usare emergencyRevoke", async function () {
            const { delegationManager, uif, uifProvinciale, unauthorizedUser, dossierId } = await loadFixture(deployDelegationFixture);

            const delegationId = ethers.id("DELEGA-EMERGENCY-002");
            await delegationManager.connect(uif).delegateAccess(
                delegationId, dossierId, uifProvinciale.address, 86400, ethers.zeroPadValue("0x", 32)
            );

            await expect(delegationManager.connect(unauthorizedUser).emergencyRevoke(
                delegationId, "Tentativo non autorizzato"
            )).to.be.revertedWithCustomError(delegationManager, "NotCoreAuthority");
        });

        it("Dovrebbe impedire a una Core Authority di revocare deleghe fuori dal proprio dominio", async function () {
            const { delegationManager, uif, ade, uifProvinciale, dossierId } = await loadFixture(deployDelegationFixture);

            // La UIF crea una delega
            const delegationId = ethers.id("DELEGA-EMERGENCY-003");
            await delegationManager.connect(uif).delegateAccess(
                delegationId, dossierId, uifProvinciale.address, 86400, ethers.zeroPadValue("0x", 32)
            );

            // L'AdE (Core Authority ma non delegante) non può revocarla
            await expect(delegationManager.connect(ade).emergencyRevoke(
                delegationId, "Tentativo fuori dominio"
            )).to.be.revertedWithCustomError(delegationManager, "NotAuthorizedToDelegate");
        });
    });

    describe("Fase 4: Gestione Anomalie (Dispute con Key Commitment)", function () {

        it("Dovrebbe permettere al gestore di segnalare una disputa con il commitment on-chain", async function () {
            const { delegationManager, uif, dossierId, dekCommitment } = await loadFixture(deployDelegationFixture);

            const tx = delegationManager.connect(uif).logDispute(dossierId, "Chiave DEK compromessa");

            await expect(tx)
                .to.emit(delegationManager, "DisputeLogged")
                .withArgs(dossierId, uif.address, "Chiave DEK compromessa", dekCommitment);

            expect(await delegationManager.activeDisputes(dossierId)).to.be.true;
        });

        it("Dovrebbe impedire a un utente non autorizzato di aprire una disputa", async function () {
            const { delegationManager, unauthorizedUser, dossierId } = await loadFixture(deployDelegationFixture);

            await expect(delegationManager.connect(unauthorizedUser).logDispute(dossierId, "Tentativo di frode"))
                .to.be.revertedWithCustomError(delegationManager, "OnlyHandlerCanDispute");
        });

        it("Dovrebbe permettere a una Core Authority di risolvere una disputa attiva", async function () {
            const { delegationManager, uif, dossierId } = await loadFixture(deployDelegationFixture);

            await delegationManager.connect(uif).logDispute(dossierId, "Chiave DEK compromessa").then((tx: any) => tx.wait());
            expect(await delegationManager.activeDisputes(dossierId)).to.be.true;

            await expect(delegationManager.connect(uif).resolveDispute(dossierId))
                .to.emit(delegationManager, "DisputeResolved")
                .withArgs(dossierId, uif.address);

            expect(await delegationManager.activeDisputes(dossierId)).to.be.false;
        });

        it("Dovrebbe impedire a un non-authority di risolvere una disputa", async function () {
            const { delegationManager, uif, unauthorizedUser, dossierId } = await loadFixture(deployDelegationFixture);

            await delegationManager.connect(uif).logDispute(dossierId, "Chiave DEK compromessa").then((tx: any) => tx.wait());

            await expect(delegationManager.connect(unauthorizedUser).resolveDispute(dossierId))
                .to.be.revertedWithCustomError(delegationManager, "NotCoreAuthority");
        });
    });
});

