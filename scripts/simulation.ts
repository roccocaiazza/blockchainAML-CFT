import { ethers, upgrades } from "hardhat";
import { CryptoEngine } from "../utils/crypto-utils";
import { DIDService, CredentialService, StorageService, DossierService } from "../services";

async function main() {
    console.log("SIMULAZIONE END-TO-END REALE: LIFECYCLE CRITTOGRAFICO E STORAGE IPFS (WP4)\n");

    // 1. Inizializzazione degli attori
    const [deployer, uif, ade, gdf, bank] = await ethers.getSigners();

    console.log("[FASE 0] Deployment Architettura Proxy UUPS in memoria...");
    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const governance = (await upgrades.deployProxy(GovernanceToken, [deployer.address], { kind: 'uups' })) as any;
    await governance.waitForDeployment();
    await (await governance.mint(uif.address)).wait();
    await (await governance.mint(ade.address)).wait();
    await (await governance.mint(gdf.address)).wait();

    const DIDRegistry = await ethers.getContractFactory("DIDRegistry");
    const didRegistryContract = (await upgrades.deployProxy(DIDRegistry, [deployer.address], { kind: 'uups' })) as any;
    await didRegistryContract.waitForDeployment();

    const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
    const credRegistryContract = (await upgrades.deployProxy(CredentialRegistry, [deployer.address], { kind: 'uups' })) as any;
    await credRegistryContract.waitForDeployment();

    const PolicyManager = await ethers.getContractFactory("PolicyManager");
    const policyManagerContract = (await upgrades.deployProxy(PolicyManager, [deployer.address, await governance.getAddress()], { kind: 'uups' })) as any;
    await policyManagerContract.waitForDeployment();

    const DocumentRegistry = await ethers.getContractFactory("DocumentRegistry");
    const docRegistryContract = (await upgrades.deployProxy(DocumentRegistry, [deployer.address, await credRegistryContract.getAddress()], { kind: 'uups' })) as any;
    await docRegistryContract.waitForDeployment();

    console.log("[SUCCESS] Contratti operativi.\n");

    // 2. Inizializzazione dell'SDK (Servizi Off-Chain)
    const didService = new DIDService(didRegistryContract);
    const credService = new CredentialService(credRegistryContract, policyManagerContract);
    const storageService = new StorageService();
    const dossierService = new DossierService(docRegistryContract, didService, storageService);

    // FASE 1: Generazione Chiavi RSA e Registrazione Identita' (DID)
    console.log("FASE 1: Registrazione Identita' e Chiavi Pubbliche (DID)\n");
    
    const keysUIF = CryptoEngine.generateRSAKeyPair();
    const keysAdE = CryptoEngine.generateRSAKeyPair();
    const keysBank = CryptoEngine.generateRSAKeyPair();

    await didService.registerDID(uif, "did:aml:uif", keysUIF.publicKey, "https://api.uif.it");
    await didService.registerDID(ade, "did:aml:ade", keysAdE.publicKey, "https://api.ade.it");
    
    const bankDid = "did:aml:banca_x";
    await didService.registerDID(bank, bankDid, keysBank.publicKey, "https://api.bancax.it");

    // FASE 2: Onboarding della Banca tramite Quorum Istituzionale
    console.log("\nFASE 2: Onboarding della Banca tramite Quorum Istituzionale\n");
    
    await credService.onboardBank(uif, ade, bank.address);

    const bankCredId = "VC-AUTH-BANCA-001";
    const bankCredHash = "CONTENUTO_OFFCHAIN_VC";
    await credService.issueCredential(uif, bankCredId, bank.address, bankCredHash);

    // FASE 3: Creazione Dossier e Storage Off-Chain (IPFS)
    console.log("\nFASE 3: Creazione Dossier, Storage Off-Chain (IPFS) e Key Wrapping\n");

    const dossierId = "DOSSIER-AML-2026-001";
    const documentoTesto = "SOS UFFICIALE: Rilevato bonifico anomalo di 5.000.000 EUR verso paradiso fiscale.";
    
    await dossierService.createAndSubmitDossier({
        submitter: bank,
        dossierId: dossierId,
        bankCredId: bankCredId,
        recipientDid: "did:aml:uif",
        recipientAddress: uif.address,
        documentBuffer: Buffer.from(documentoTesto, "utf-8")
    });

    // FASE 4: Triage UIF, Decifratura e Re-Wrapping per AdE
    console.log("\nFASE 4: Triage UIF, Decifratura e Re-Wrapping per AdE\n");

    const documentoAggiornato = "SOS UFFICIALE + NOTA UIF: Accertata anomalia nei flussi. Si passa ad AdE.";
    const STATE_FISCAL_REVIEW = 2; // Da enum DocumentRegistry.DossierState

    await dossierService.reviewAndForwardDossier({
        handler: uif,
        handlerPrivateKey: keysUIF.privateKey,
        dossierId: dossierId,
        nextRecipientDid: "did:aml:ade",
        nextRecipientAddress: ade.address,
        nextState: STATE_FISCAL_REVIEW,
        updatedDocumentBuffer: Buffer.from(documentoAggiornato, "utf-8")
    });

    console.log("\nSIMULAZIONE CONCLUSA CON SUCCESSO. CATENA CRITTOGRAFICA E STORAGE VERIFICATI.\n");

    // Spegnimento del nodo IPFS
    await storageService.shutdown();
}

main().catch((error) => {
    console.error("[ERRORE CRITICO] Fallimento durante l'esecuzione della simulazione:", error);
    process.exitCode = 1;
});