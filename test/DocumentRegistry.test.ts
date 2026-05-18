import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("Suite di Test: Modulo Documentale e Macchina a Stati (DocumentRegistry)", function () {

    // Fixture: Configura l'ambiente e inietta le dipendenze prima di ogni test
    async function deployDocumentFrameworkFixture() {
        const [deployer, uif, ade, gdf, bank, unauthorizedBank] = await ethers.getSigners();

        // 1. Deployment del Credential Registry (necessario per verificare le autorizzazioni)
        const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
        const credRegistry = (await upgrades.deployProxy(CredentialRegistry, [deployer.address], { kind: 'uups' })) as any;
        await credRegistry.waitForDeployment();

        // 2. Deployment del Document Registry
        const DocumentRegistry = await ethers.getContractFactory("DocumentRegistry");
        const docRegistry = (await upgrades.deployProxy(DocumentRegistry, [deployer.address, await credRegistry.getAddress()], { kind: 'uups' })) as any;
        await docRegistry.waitForDeployment();

        // 3. Emissione di una Credenziale Verificabile (VC) valida per la banca autorizzata
        const validBankCredId = ethers.id("VC-AUTH-BANCA-VALIDA");
        const credHash = ethers.id("OFFCHAIN_HASH");
        // Simuliamo che il deployer (o la UIF) emetta la credenziale per la banca
        await credRegistry.issueCredential(validBankCredId, bank.address, credHash);

        // Variabili costanti per la simulazione
        const sampleDossierId = ethers.id("DOSSIER-TEST-001");
        const initialCid = "ipfs://initial-cid-hash";
        const initialDek = "0xEncryptedDekForUIF";

        // Mappatura degli stati: 0=SUBMITTED, 1=UNDER_ANALYSIS, 2=FISCAL_REVIEW, 3=IN_INVESTIGATION, 4=ARCHIVED
        const STATES = {
            SUBMITTED: 0,
            UNDER_ANALYSIS: 1,
            FISCAL_REVIEW: 2,
            IN_INVESTIGATION: 3,
            ARCHIVED: 4
        };

        return {
            docRegistry, credRegistry, deployer, uif, ade, gdf, bank, unauthorizedBank,
            validBankCredId, sampleDossierId, initialCid, initialDek, STATES
        };
    }

    describe("Fase 1: Sottomissione e Controllo Autorizzazioni", function () {

        it("Dovrebbe permettere a una banca con credenziali valide di inviare un dossier", async function () {
            const { docRegistry, bank, uif, validBankCredId, sampleDossierId, initialCid, initialDek, STATES } = await loadFixture(deployDocumentFrameworkFixture);

            await expect(docRegistry.connect(bank).submitDossier(
                sampleDossierId, validBankCredId, uif.address, initialCid, initialDek
            )).to.emit(docRegistry, "DossierSubmitted")
                .withArgs(sampleDossierId, bank.address, initialCid);

            // Verifica l'integrità dello stato salvato on-chain
            const dossier = await docRegistry.dossiers(sampleDossierId);
            expect(dossier.submitter).to.equal(bank.address);
            expect(dossier.currentHandler).to.equal(uif.address); // La UIF riceve il fascicolo
            expect(dossier.state).to.equal(STATES.SUBMITTED);
            expect(dossier.ipfsCid).to.equal(initialCid);
        });

        it("Dovrebbe bloccare l'invio da parte di una banca priva di Verifiable Credential", async function () {
            const { docRegistry, unauthorizedBank, uif, sampleDossierId, initialCid, initialDek } = await loadFixture(deployDocumentFrameworkFixture);

            const invalidCredId = ethers.id("VC-INESISTENTE");

            await expect(docRegistry.connect(unauthorizedBank).submitDossier(
                sampleDossierId, invalidCredId, uif.address, initialCid, initialDek
            )).to.be.revertedWith("Errore: Banca non autorizzata o credenziale revocata");
        });
    });

    describe("Fase 2: Transizioni di Stato e Catena di Custodia", function () {

        it("Dovrebbe permettere all'Autorita' in carico di effettuare il re-wrapping e passare il dossier", async function () {
            const { docRegistry, bank, uif, ade, validBankCredId, sampleDossierId, initialCid, initialDek, STATES } = await loadFixture(deployDocumentFrameworkFixture);

            // Setup: La banca invia il dossier alla UIF
            await docRegistry.connect(bank).submitDossier(sampleDossierId, validBankCredId, uif.address, initialCid, initialDek);

            const newCid = "ipfs://updated-cid-with-uif-report";
            const newDekForAde = "0xEncryptedDekForADE";

            // Test: La UIF passa il fascicolo all'AdE
            await expect(docRegistry.connect(uif).transitionDossier(
                sampleDossierId, STATES.FISCAL_REVIEW, ade.address, newCid, newDekForAde
            )).to.emit(docRegistry, "DossierStateTransitioned")
                .withArgs(sampleDossierId, STATES.FISCAL_REVIEW, uif.address);

            // Verifica dell'aggiornamento strutturale
            const dossier = await docRegistry.dossiers(sampleDossierId);
            expect(dossier.currentHandler).to.equal(ade.address); // Il nuovo gestore è l'AdE
            expect(dossier.state).to.equal(STATES.FISCAL_REVIEW);
            expect(dossier.ipfsCid).to.equal(newCid);
        });

        it("Dovrebbe impedire a un'Autorita' non in carico di alterare il dossier", async function () {
            const { docRegistry, bank, uif, gdf, validBankCredId, sampleDossierId, initialCid, initialDek, STATES } = await loadFixture(deployDocumentFrameworkFixture);

            // Setup: La banca invia il dossier alla UIF
            await docRegistry.connect(bank).submitDossier(sampleDossierId, validBankCredId, uif.address, initialCid, initialDek);

            // Test: La GdF tenta di forzare una transizione su un dossier che e' attualmente della UIF
            await expect(docRegistry.connect(gdf).transitionDossier(
                sampleDossierId, STATES.IN_INVESTIGATION, gdf.address, "ipfs://fake", "0xfake"
            )).to.be.revertedWith("Errore: Non hai in carico questo dossier");
        });

        it("Dovrebbe impedire matematicamente la regressione dello stato del dossier", async function () {
            const { docRegistry, bank, uif, ade, validBankCredId, sampleDossierId, initialCid, initialDek, STATES } = await loadFixture(deployDocumentFrameworkFixture);

            // Setup
            await docRegistry.connect(bank).submitDossier(sampleDossierId, validBankCredId, uif.address, initialCid, initialDek);
            await docRegistry.connect(uif).transitionDossier(sampleDossierId, STATES.FISCAL_REVIEW, ade.address, "ipfs://...", "0x...");

            // Test: L'AdE tenta di riportare il dossier allo stato precedente (SUBMITTED)
            await expect(docRegistry.connect(ade).transitionDossier(
                sampleDossierId, STATES.SUBMITTED, uif.address, "ipfs://...", "0x..."
            )).to.be.revertedWith("Errore: Il dossier puo' solo avanzare di stato");
        });
    });
});