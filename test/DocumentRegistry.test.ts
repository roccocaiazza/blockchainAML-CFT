import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { CryptoEngine } from "../utils/crypto-utils";

describe("Suite di Test: Modulo Documentale e Macchina a Stati (DocumentRegistry)", function () {

    async function deployDocumentFrameworkFixture() {
        const [deployer, uif, ade, gdf, bank, unauthorizedBank] = await ethers.getSigners();

        const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
        const credRegistry = (await upgrades.deployProxy(CredentialRegistry, [deployer.address], { kind: 'uups' })) as any;
        await credRegistry.waitForDeployment();

        const DIDRegistry = await ethers.getContractFactory("DIDRegistry");
        const didRegistry = (await upgrades.deployProxy(DIDRegistry, [deployer.address], { kind: 'uups' })) as any;
        await didRegistry.waitForDeployment();

        // DocumentRegistry ora richiede l'indirizzo UIF come terzo parametro
        const DocumentRegistry = await ethers.getContractFactory("DocumentRegistry");
        const docRegistry = (await upgrades.deployProxy(
            DocumentRegistry,
            [deployer.address, await credRegistry.getAddress(), uif.address],
            { kind: 'uups' }
        )) as any;
        await docRegistry.waitForDeployment();

        // DelegationManager collegato al DocumentRegistry e al DIDRegistry
        const DelegationManager = await ethers.getContractFactory("DelegationManager");
        const delegationManager = (await upgrades.deployProxy(
            DelegationManager,
            [deployer.address, await docRegistry.getAddress(), [uif.address, ade.address, gdf.address], await didRegistry.getAddress()],
            { kind: 'uups' }
        )) as any;
        await delegationManager.waitForDeployment();

        // Collegamento bidirezionale per il freeze in caso di disputa
        await docRegistry.setDelegationManager(await delegationManager.getAddress()).then((tx: any) => tx.wait());

        const validBankCredId = ethers.id("VC-AUTH-BANCA-VALIDA");
        await credRegistry.issueCredential(validBankCredId, bank.address, ethers.id("OFFCHAIN_HASH"));

        const sampleDossierId = ethers.id("DOSSIER-TEST-001");
        const initialCid = ethers.toUtf8Bytes("ipfs://initial-cid-hash");
        const initialDek = ethers.toUtf8Bytes("0xEncryptedDekForUIF");

        // Genera un DEK reale e il suo commitment per i test
        const dek = CryptoEngine.generateDEK();
        const dekCommitment = CryptoEngine.computeDEKCommitment(dek);

        const STATES = {
            SUBMITTED: 0, UNDER_ANALYSIS: 1, FISCAL_REVIEW: 2, IN_INVESTIGATION: 3, ARCHIVED: 4
        };

        return {
            docRegistry, credRegistry, delegationManager, deployer, uif, ade, gdf, bank, unauthorizedBank,
            validBankCredId, sampleDossierId, initialCid, initialDek, dekCommitment, dek, STATES
        };
    }

    describe("Fase 1: Sottomissione e Controllo Autorizzazioni", function () {

        it("Dovrebbe permettere a una banca con credenziali valide di inviare un dossier alla UIF", async function () {
            const { docRegistry, bank, uif, validBankCredId, sampleDossierId, initialCid, initialDek, dekCommitment, STATES } =
                await loadFixture(deployDocumentFrameworkFixture);

            await expect(docRegistry.connect(bank).submitDossier(
                sampleDossierId, validBankCredId, uif.address, initialCid, initialDek, dekCommitment
            )).to.emit(docRegistry, "DossierSubmitted")
                .withArgs(sampleDossierId, bank.address, initialCid, dekCommitment);

            const dossier = await docRegistry.dossiers(sampleDossierId);
            expect(dossier.submitter).to.equal(bank.address);
            expect(dossier.currentHandler).to.equal(uif.address);
            expect(dossier.state).to.equal(STATES.SUBMITTED);
            // Verifica che il Key Commitment sia stato salvato on-chain
            expect(dossier.dekCommitment).to.equal(dekCommitment);
        });

        it("Dovrebbe bloccare l'invio da parte di una banca priva di Verifiable Credential", async function () {
            const { docRegistry, unauthorizedBank, uif, sampleDossierId, initialCid, initialDek, dekCommitment } =
                await loadFixture(deployDocumentFrameworkFixture);

            const invalidCredId = ethers.id("VC-INESISTENTE");

            await expect(docRegistry.connect(unauthorizedBank).submitDossier(
                sampleDossierId, invalidCredId, uif.address, initialCid, initialDek, dekCommitment
            )).to.be.revertedWithCustomError(docRegistry, "BankNotAuthorized");
        });

        it("Dovrebbe bloccare l'invio con un DEK Commitment nullo (bytes32(0))", async function () {
            const { docRegistry, bank, uif, validBankCredId, sampleDossierId, initialCid, initialDek } =
                await loadFixture(deployDocumentFrameworkFixture);

            const zeroDekCommitment = ethers.zeroPadValue("0x", 32);

            await expect(docRegistry.connect(bank).submitDossier(
                sampleDossierId, validBankCredId, uif.address, initialCid, initialDek, zeroDekCommitment
            )).to.be.revertedWithCustomError(docRegistry, "InvalidDEKCommitment");
        });

        // test per il vincolo UIF come primo handler obbligatorio
        it("Dovrebbe bloccare l'invio diretto a un'autorita' diversa dalla UIF (MustSubmitToUIF)", async function () {
            const { docRegistry, bank, ade, validBankCredId, sampleDossierId, initialCid, initialDek, dekCommitment } =
                await loadFixture(deployDocumentFrameworkFixture);

            await expect(docRegistry.connect(bank).submitDossier(
                sampleDossierId, validBankCredId, ade.address, initialCid, initialDek, dekCommitment
            )).to.be.revertedWithCustomError(docRegistry, "MustSubmitToUIF");
        });
    });

    describe("Fase 2: Transizioni di Stato e Catena di Custodia", function () {

        it("Dovrebbe permettere all'Autorita' in carico di effettuare il re-wrapping e passare il dossier (FSM rigida)", async function () {
            const { docRegistry, bank, uif, ade, validBankCredId, sampleDossierId, initialCid, initialDek, dekCommitment, STATES } =
                await loadFixture(deployDocumentFrameworkFixture);

            await docRegistry.connect(bank).submitDossier(
                sampleDossierId, validBankCredId, uif.address, initialCid, initialDek, dekCommitment
            );

            // la UIF deve passare prima per UNDER_ANALYSIS, non può saltare a FISCAL_REVIEW
            const c2 = CryptoEngine.computeDEKCommitment(CryptoEngine.generateDEK());
            await docRegistry.connect(uif).transitionDossier(
                sampleDossierId, STATES.UNDER_ANALYSIS, uif.address,
                ethers.toUtf8Bytes("ipfs://uif-triage"), ethers.toUtf8Bytes("0xDek2"), c2
            );

            const newCid = ethers.toUtf8Bytes("ipfs://updated-cid-with-uif-report");
            const newDekForAde = ethers.toUtf8Bytes("0xEncryptedDekForADE");
            const newDek = CryptoEngine.generateDEK();
            const newDekCommitment = CryptoEngine.computeDEKCommitment(newDek);

            await expect(docRegistry.connect(uif).transitionDossier(
                sampleDossierId, STATES.FISCAL_REVIEW, ade.address, newCid, newDekForAde, newDekCommitment
            )).to.emit(docRegistry, "DossierStateTransitioned")
                .withArgs(sampleDossierId, STATES.FISCAL_REVIEW, uif.address, newDekCommitment);

            const dossier = await docRegistry.dossiers(sampleDossierId);
            expect(dossier.currentHandler).to.equal(ade.address);
            expect(dossier.state).to.equal(STATES.FISCAL_REVIEW);
            expect(dossier.dekCommitment).to.equal(newDekCommitment);
        });

        it("Dovrebbe impedire salti di stato non ammessi dalla FSM (es. SUBMITTED → FISCAL_REVIEW)", async function () {
            const { docRegistry, bank, uif, ade, validBankCredId, sampleDossierId, initialCid, initialDek, dekCommitment, STATES } =
                await loadFixture(deployDocumentFrameworkFixture);

            await docRegistry.connect(bank).submitDossier(
                sampleDossierId, validBankCredId, uif.address, initialCid, initialDek, dekCommitment
            );

            const fakeDek = CryptoEngine.computeDEKCommitment(CryptoEngine.generateDEK());
            // Salto diretto SUBMITTED → FISCAL_REVIEW: deve essere bloccato
            await expect(docRegistry.connect(uif).transitionDossier(
                sampleDossierId, STATES.FISCAL_REVIEW, ade.address,
                ethers.toUtf8Bytes("ipfs://skip"), ethers.toUtf8Bytes("0xskip"), fakeDek
            )).to.be.revertedWithCustomError(docRegistry, "InvalidStateTransition");
        });

        it("Dovrebbe impedire a un'Autorita' non in carico di alterare il dossier", async function () {
            const { docRegistry, bank, uif, gdf, validBankCredId, sampleDossierId, initialCid, initialDek, dekCommitment, STATES } =
                await loadFixture(deployDocumentFrameworkFixture);

            await docRegistry.connect(bank).submitDossier(
                sampleDossierId, validBankCredId, uif.address, initialCid, initialDek, dekCommitment
            );

            const fakeDekCommitment = CryptoEngine.computeDEKCommitment(CryptoEngine.generateDEK());

            await expect(docRegistry.connect(gdf).transitionDossier(
                sampleDossierId, STATES.IN_INVESTIGATION, gdf.address,
                ethers.toUtf8Bytes("ipfs://fake"), ethers.toUtf8Bytes("0xfake"), fakeDekCommitment
            )).to.be.revertedWithCustomError(docRegistry, "NotDossierHandler");
        });

        it("Dovrebbe impedire matematicamente la regressione dello stato del dossier", async function () {
            const { docRegistry, bank, uif, ade, validBankCredId, sampleDossierId, initialCid, initialDek, dekCommitment, STATES } =
                await loadFixture(deployDocumentFrameworkFixture);

            await docRegistry.connect(bank).submitDossier(
                sampleDossierId, validBankCredId, uif.address, initialCid, initialDek, dekCommitment
            );
            const dek2 = CryptoEngine.generateDEK();
            const commitment2 = CryptoEngine.computeDEKCommitment(dek2);
            // SUBMITTED → UNDER_ANALYSIS (step obbligatorio)
            await docRegistry.connect(uif).transitionDossier(
                sampleDossierId, STATES.UNDER_ANALYSIS, uif.address,
                ethers.toUtf8Bytes("ipfs://..."), ethers.toUtf8Bytes("0x..."), commitment2
            );
            const dek3 = CryptoEngine.generateDEK();
            const commitment3 = CryptoEngine.computeDEKCommitment(dek3);
            // Tentativo di regressione UNDER_ANALYSIS → SUBMITTED: deve fallire
            await expect(docRegistry.connect(uif).transitionDossier(
                sampleDossierId, STATES.SUBMITTED, uif.address,
                ethers.toUtf8Bytes("ipfs://..."), ethers.toUtf8Bytes("0x..."), commitment3
            )).to.be.revertedWithCustomError(docRegistry, "InvalidStateTransition");
        });

        // test per il congelamento del dossier in caso di disputa attiva
        it("Dovrebbe bloccare le transizioni di stato se è aperta una disputa crittografica (DossierFrozen)", async function () {
            const { docRegistry, delegationManager, bank, uif, validBankCredId, sampleDossierId, initialCid, initialDek, dekCommitment, STATES } =
                await loadFixture(deployDocumentFrameworkFixture);

            await docRegistry.connect(bank).submitDossier(
                sampleDossierId, validBankCredId, uif.address, initialCid, initialDek, dekCommitment
            );

            // La UIF segnala una disputa crittografica sul dossier
            await delegationManager.connect(uif).logDispute(sampleDossierId, "DEK corrotta").then((tx: any) => tx.wait());
            expect(await delegationManager.activeDisputes(sampleDossierId)).to.be.true;

            // Qualsiasi tentativo di transizione deve essere bloccato
            const fakeDek = CryptoEngine.computeDEKCommitment(CryptoEngine.generateDEK());
            await expect(docRegistry.connect(uif).transitionDossier(
                sampleDossierId, STATES.UNDER_ANALYSIS, uif.address,
                ethers.toUtf8Bytes("ipfs://frozen"), ethers.toUtf8Bytes("0xfrozen"), fakeDek
            )).to.be.revertedWithCustomError(docRegistry, "DossierFrozen");
        });

        it("Dovrebbe bloccare qualsiasi transizione su un dossier in stato ARCHIVED", async function () {
            const { docRegistry, bank, uif, ade, gdf, validBankCredId, sampleDossierId, initialCid, initialDek, dekCommitment, STATES } =
                await loadFixture(deployDocumentFrameworkFixture);

            // Porta il dossier fino ad ARCHIVED rispettando la FSM rigida
            await docRegistry.connect(bank).submitDossier(
                sampleDossierId, validBankCredId, uif.address, initialCid, initialDek, dekCommitment
            );
            const c2 = CryptoEngine.computeDEKCommitment(CryptoEngine.generateDEK());
            await docRegistry.connect(uif).transitionDossier(
                sampleDossierId, STATES.UNDER_ANALYSIS, uif.address,
                ethers.toUtf8Bytes("ipfs://2"), ethers.toUtf8Bytes("0x2"), c2
            );
            const c3 = CryptoEngine.computeDEKCommitment(CryptoEngine.generateDEK());
            await docRegistry.connect(uif).transitionDossier(
                sampleDossierId, STATES.FISCAL_REVIEW, ade.address,
                ethers.toUtf8Bytes("ipfs://3"), ethers.toUtf8Bytes("0x3"), c3
            );
            const c4 = CryptoEngine.computeDEKCommitment(CryptoEngine.generateDEK());
            await docRegistry.connect(ade).transitionDossier(
                sampleDossierId, STATES.IN_INVESTIGATION, gdf.address,
                ethers.toUtf8Bytes("ipfs://4"), ethers.toUtf8Bytes("0x4"), c4
            );
            const c5 = CryptoEngine.computeDEKCommitment(CryptoEngine.generateDEK());
            await docRegistry.connect(gdf).transitionDossier(
                sampleDossierId, STATES.ARCHIVED, gdf.address,
                ethers.toUtf8Bytes("ipfs://5"), ethers.toUtf8Bytes("0x5"), c5
            );

            // Qualsiasi ulteriore transizione deve essere bloccata con DossierArchived
            const c6 = CryptoEngine.computeDEKCommitment(CryptoEngine.generateDEK());
            await expect(docRegistry.connect(gdf).transitionDossier(
                sampleDossierId, STATES.ARCHIVED, gdf.address,
                ethers.toUtf8Bytes("ipfs://6"), ethers.toUtf8Bytes("0x6"), c6
            )).to.be.revertedWithCustomError(docRegistry, "DossierArchived");
        });
    });
});
