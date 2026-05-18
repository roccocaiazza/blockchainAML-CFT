import { ethers, upgrades } from "hardhat";

async function main() {
    console.log("AVVIO DELLA PROCEDURA DI DEPLOYMENT: FRAMEWORK MULTI-AUTORITA AML/CFT");

    // Recupero degli account per la simulazione degli attori istituzionali ed economici
    const [deployer, uif, ade, gdf] = await ethers.getSigners();

    console.log(`[ACCOUNT] Super-Admin (Deployer):          ${deployer.address}`);
    console.log(`[ACCOUNT] Unita' di Informazione Finanziaria (UIF): ${uif.address}`);
    console.log(`[ACCOUNT] Agenzia delle Entrate (AdE):       ${ade.address}`);
    console.log(`[ACCOUNT] Guardia di Finanza (GdF):          ${gdf.address}\n`);

    console.log("Fase 1: Deployment dei contratti di Governance e Identita'");

    // =========================================================================
    // 1. DEPLOYMENT DEL GOVERNANCE TOKEN (PROXY UUPS)
    // =========================================================================
    console.log("[PROCESSO] Inizializzazione di GovernanceToken...");
    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const governanceToken = await upgrades.deployProxy(
        GovernanceToken,
        [deployer.address],
        { kind: 'uups' }
    );
    await governanceToken.waitForDeployment();
    const govAddress = await governanceToken.getAddress();
    console.log(`[SUCCESS] GovernanceToken (Proxy) distribuito all'indirizzo: ${govAddress}`);

    // Assegnazione dei Soulbound Token di governance alle Autorità Core
    console.log("[PROCESSO] Configurazione dei diritti di voto (Minting SBT)...");
    await (await governanceToken.mint(uif.address)).wait();
    await (await governanceToken.mint(ade.address)).wait();
    await (await governanceToken.mint(gdf.address)).wait();
    console.log("[SUCCESS] Assegnazione dei Soulbound Token completata per UIF, AdE e GdF.\n");

    // =========================================================================
    // 2. DEPLOYMENT DEL DID REGISTRY (PROXY UUPS)
    // =========================================================================
    console.log("[PROCESSO] Inizializzazione di DIDRegistry...");
    const DIDRegistry = await ethers.getContractFactory("DIDRegistry");
    const didRegistry = await upgrades.deployProxy(
        DIDRegistry,
        [deployer.address],
        { kind: 'uups' }
    );
    await didRegistry.waitForDeployment();
    const didAddress = await didRegistry.getAddress();
    console.log(`[SUCCESS] DIDRegistry (Proxy) distribuito all'indirizzo:     ${didAddress}\n`);

    // =========================================================================
    // 3. DEPLOYMENT DEL CREDENTIAL REGISTRY (PROXY UUPS)
    // =========================================================================
    console.log("[PROCESSO] Inizializzazione di CredentialRegistry...");
    const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
    const credentialRegistry = await upgrades.deployProxy(
        CredentialRegistry,
        [deployer.address],
        { kind: 'uups' }
    );
    await credentialRegistry.waitForDeployment();
    const credAddress = await credentialRegistry.getAddress();
    console.log(`[SUCCESS] CredentialRegistry (Proxy) distribuito all'indirizzo: ${credAddress}\n`);

    // =========================================================================
    // 4. DEPLOYMENT DEL POLICY MANAGER (PROXY UUPS)
    // =========================================================================
    console.log("[PROCESSO] Inizializzazione di PolicyManager...");
    const PolicyManager = await ethers.getContractFactory("PolicyManager");
    const policyManager = await upgrades.deployProxy(
        PolicyManager,
        [deployer.address, govAddress],
        { kind: 'uups' }
    );
    await policyManager.waitForDeployment();
    const policyAddress = await policyManager.getAddress();
    console.log(`[SUCCESS] PolicyManager (Proxy) distribuito all'indirizzo:   ${policyAddress}\n`);

    console.log("Fase 2: Deployment del modulo di gestione documentale e stati dei dossier");

    // =========================================================================
    // 5. DEPLOYMENT DEL DOCUMENT REGISTRY (PROXY UUPS)
    // =========================================================================
    console.log("[PROCESSO] Inizializzazione di DocumentRegistry...");
    const DocumentRegistry = await ethers.getContractFactory("DocumentRegistry");
    const documentRegistry = await upgrades.deployProxy(
        DocumentRegistry,
        [deployer.address, credAddress],
        { kind: 'uups' }
    );
    await documentRegistry.waitForDeployment();
    const docAddress = await documentRegistry.getAddress();
    console.log(`[SUCCESS] DocumentRegistry (Proxy) distribuito all'indirizzo: ${docAddress}\n`);

    console.log("CONFIGURAZIONE TERMINATA: L'architettura dei contratti è pienamente operativa.");
}

main().catch((error) => {
    console.error("[ERRORE CRITICO] Errore durante la procedura di deployment:", error);
    process.exitCode = 1;
});