import { ethers, upgrades } from "hardhat";
import { performance } from "perf_hooks";
import { CryptoEngine } from "../utils/crypto-utils";

async function main() {
    console.log("AVVIO DELLA SUITE DI BENCHMARKING (GAS & LATENZA)\n");

    const [deployer, uif, ade, gdf, bank, uifProvinciale] = await ethers.getSigners();
    const metrics: any[] = [];

    // Helper per misurare tempo e gas di una transazione
    async function measureTx(name: string, txPromise: Promise<any>) {
        const start = performance.now();
        const tx = await txPromise;
        const receipt = await tx.wait();
        const end = performance.now();

        metrics.push({
            "Transaction Type": name,
            "Gas Used": receipt.gasUsed.toString(),
            "Execution Time (ms)": (end - start).toFixed(2)
        });
        return receipt;
    }

    // -------------------------------------------------------------------------
    // DEPLOYMENT
    // -------------------------------------------------------------------------
    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const governance = (await upgrades.deployProxy(GovernanceToken, [deployer.address], { kind: 'uups' })) as any;
    await governance.waitForDeployment();

    const DIDRegistry = await ethers.getContractFactory("DIDRegistry");
    const didRegistry = (await upgrades.deployProxy(DIDRegistry, [deployer.address], { kind: 'uups' })) as any;
    await didRegistry.waitForDeployment();

    const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
    const credRegistry = (await upgrades.deployProxy(CredentialRegistry, [deployer.address], { kind: 'uups' })) as any;
    await credRegistry.waitForDeployment();

    const PolicyManager = await ethers.getContractFactory("PolicyManager");
    const policyManager = (await upgrades.deployProxy(PolicyManager, [deployer.address, await governance.getAddress()], { kind: 'uups' })) as any;
    await policyManager.waitForDeployment();

    const DocumentRegistry = await ethers.getContractFactory("DocumentRegistry");
    const startDeploy = performance.now();
    const docRegistry = (await upgrades.deployProxy(DocumentRegistry, [deployer.address, await credRegistry.getAddress()], { kind: 'uups' })) as any;
    await docRegistry.waitForDeployment();
    const endDeploy = performance.now();

    const deployTx = docRegistry.deploymentTransaction();
    const deployReceipt = await deployTx.wait();
    metrics.push({
        "Transaction Type": "Deploy DocumentRegistry (Proxy)",
        "Gas Used": deployReceipt.gasUsed.toString(),
        "Execution Time (ms)": (endDeploy - startDeploy).toFixed(2)
    });

    // DelegationManager con Core Authorities
    const DelegationManager = await ethers.getContractFactory("DelegationManager");
    const delegationManager = (await upgrades.deployProxy(
        DelegationManager,
        [deployer.address, await docRegistry.getAddress(), [uif.address, ade.address, gdf.address]],
        { kind: 'uups' }
    )) as any;
    await delegationManager.waitForDeployment();

    // -------------------------------------------------------------------------
    // TRANSAZIONI OPERATIVE
    // -------------------------------------------------------------------------

    await Promise.all([
        measureTx("Mint Governance Token (SBT) - UIF", governance.mint(uif.address)),
        governance.mint(ade.address).then((tx: any) => tx.wait()),
        governance.mint(gdf.address).then((tx: any) => tx.wait())
    ]);

    await measureTx(
        "Register DID (Banca)",
        didRegistry.connect(bank).registerDID(
            ethers.encodeBytes32String("did:aml:banca_x"),
            ethers.toUtf8Bytes("0xPublicKeyMock"),
            ethers.toUtf8Bytes("https://api.banca.it")
        )
    );

    // --- Membership Policy: Propose + Vote (quorum 2/3, Timelock avviato) ---
    await measureTx(
        "Propose Bank Onboarding",
        policyManager.connect(uif).proposeBankOnboarding(bank.address)
    );

    await measureTx(
        "Vote (Approve Onboarding — avvia Timelock 48h)",
        policyManager.connect(ade).vote(0)
    );

    // --- System Upgrade Policy: Propose + Vote x3 (unanimità 3/3) ---
    const mockNewImpl = ethers.Wallet.createRandom().address; // indirizzo fittizio per il benchmark
    const targetProxy = await docRegistry.getAddress();

    await measureTx(
        "Propose Upgrade (UUPS — voto 1/3)",
        policyManager.connect(uif).proposeUpgrade(targetProxy, mockNewImpl)
    );
    await measureTx(
        "Vote Upgrade (voto 2/3)",
        policyManager.connect(ade).voteUpgrade(0)
    );
    await measureTx(
        "Vote Upgrade (voto 3/3 — unanimità, avvia Timelock)",
        policyManager.connect(gdf).voteUpgrade(0)
    );

    // --- Credential + Dossier ---
    const bankCredId = ethers.id("VC-AUTH-BANCA-001");
    await measureTx(
        "Issue Verifiable Credential",
        credRegistry.connect(uif).issueCredential(bankCredId, bank.address, ethers.id("HASH"))
    );

    // Genera un DEK reale e il suo commitment per il benchmark
    const dek = CryptoEngine.generateDEK();
    const dekCommitment = CryptoEngine.computeDEKCommitment(dek);

    const dossierId = ethers.id("DOSSIER-BENCHMARK-01");
    await measureTx(
        "Submit Dossier (con DEK Commitment)",
        docRegistry.connect(bank).submitDossier(
            dossierId,
            bankCredId,
            uif.address,
            ethers.toUtf8Bytes("ipfs://mockCID"),
            ethers.toUtf8Bytes("0xEncryptedDEK"),
            dekCommitment
        )
    );

    const newDekCommitment = CryptoEngine.computeDEKCommitment(CryptoEngine.generateDEK());
    await measureTx(
        "Transition Dossier (to FISCAL_REVIEW, con DEK Commitment)",
        docRegistry.connect(uif).transitionDossier(
            dossierId,
            2,
            ade.address,
            ethers.toUtf8Bytes("ipfs://mockCID_v2"),
            ethers.toUtf8Bytes("0xEncryptedDEK_v2"),
            newDekCommitment
        )
    );

    // --- Delegation + Revoca normale ---
    const delegationId = ethers.id("DELEGA-TEST-01");
    await measureTx(
        "Delegate Access (con TTL e depth check)",
        delegationManager.connect(ade).delegateAccess(
            delegationId,
            dossierId,
            uifProvinciale.address,
            86400,
            ethers.zeroPadValue("0x", 32)
        )
    );

    await measureTx(
        "Revoke Delegation (normale)",
        delegationManager.connect(ade).revokeDelegation(delegationId)
    );

    // --- Emergency Revoke (Fast-Track, GdF) ---
    // Crea una delega della GdF per poterla revocare d'emergenza
    const emergencyDelegId = ethers.id("DELEGA-EMERGENCY-01");
    // La GdF deve essere handler del dossier — usiamo un dossier separato per il benchmark
    // Qui misuriamo solo il costo della chiamata emergencyRevoke su una delega esistente
    // (la GdF è Core Authority, quindi isCoreAuthority[gdf] = true)
    // Per semplicità creiamo la delega come ade (che è handler del dossier dopo la transizione)
    await delegationManager.connect(ade).delegateAccess(
        emergencyDelegId,
        dossierId,
        uifProvinciale.address,
        86400,
        ethers.zeroPadValue("0x", 32)
    );
    await measureTx(
        "Emergency Revoke (Fast-Track, Core Authority)",
        delegationManager.connect(ade).emergencyRevoke(
            emergencyDelegId,
            "Benchmark: test revoca d'emergenza"
        )
    );

    // -------------------------------------------------------------------------
    // RISULTATI
    // -------------------------------------------------------------------------
    console.log("\nRISULTATI DEL BENCHMARK (ON-CHAIN)");
    console.table(metrics);
}

main().catch((error) => {
    console.error("Errore durante il benchmark:", error);
    process.exitCode = 1;
});
