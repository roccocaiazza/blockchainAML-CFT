import { ethers, upgrades } from "hardhat";
import { performance } from "perf_hooks";
import { CryptoEngine } from "../utils/crypto-utils";

// Utility
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("   SUITE DI BENCHMARKING — LATENCY · THROUGHPUT · STORAGE     ");
    console.log("═══════════════════════════════════════════════════════════════\n");

    const [deployer, uif, ade, gdf, bank, uifProvinciale] = await ethers.getSigners();

    // DEPLOYMENT (comune a tutte le sezioni)
    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    const governance = (await upgrades.deployProxy(GovernanceToken, [deployer.address], { kind: "uups" })) as any;
    await governance.waitForDeployment();

    const DIDRegistry = await ethers.getContractFactory("DIDRegistry");
    const didRegistry = (await upgrades.deployProxy(DIDRegistry, [deployer.address], { kind: "uups" })) as any;
    await didRegistry.waitForDeployment();

    const CredentialRegistry = await ethers.getContractFactory("CredentialRegistry");
    const credRegistry = (await upgrades.deployProxy(CredentialRegistry, [deployer.address], { kind: "uups" })) as any;
    await credRegistry.waitForDeployment();

    const PolicyManager = await ethers.getContractFactory("PolicyManager");
    const policyManager = (await upgrades.deployProxy(PolicyManager,
        [deployer.address, await governance.getAddress()], { kind: "uups" })) as any;
    await policyManager.waitForDeployment();

    const DocumentRegistry = await ethers.getContractFactory("DocumentRegistry");
    const startDeploy = performance.now();
    const docRegistry = (await upgrades.deployProxy(DocumentRegistry,
        // uif.address obbligatorio come primo handler della SOS
        [deployer.address, await credRegistry.getAddress(), uif.address], { kind: "uups" })) as any;
    await docRegistry.waitForDeployment();
    const endDeploy = performance.now();

    const deployTx = docRegistry.deploymentTransaction();
    const deployReceipt = await deployTx.wait();

    const DelegationManager = await ethers.getContractFactory("DelegationManager");
    const delegationManager = (await upgrades.deployProxy(
        DelegationManager,
        // Aggiunto didRegistry per la verifica DID in checkAccess
        [deployer.address, await docRegistry.getAddress(), [uif.address, ade.address, gdf.address], await didRegistry.getAddress()],
        { kind: "uups" })) as any;
    await delegationManager.waitForDeployment();

    // Collega DelegationManager al DocumentRegistry per il freeze in caso di disputa
    await docRegistry.setDelegationManager(await delegationManager.getAddress()).then((tx: any) => tx.wait());

    // Minting SBT a tutte e tre le autorità prima delle transazioni
    await governance.mint(uif.address).then((tx: any) => tx.wait());
    await governance.mint(ade.address).then((tx: any) => tx.wait());
    await governance.mint(gdf.address).then((tx: any) => tx.wait());

    // SEZIONE A — LATENCY & GAS per singola operazione
    console.log("SEZIONE A: LATENCY & GAS PER OPERAZIONE\n");

    const latencyMetrics: any[] = [];

    async function measureTx(name: string, txPromise: Promise<any>) {
        const start = performance.now();
        const tx = await txPromise;
        const receipt = await tx.wait();
        const end = performance.now();
        latencyMetrics.push({
            "Operazione": name,
            "Gas Used": Number(receipt.gasUsed).toLocaleString("it-IT"),
            "Latenza (ms)": (end - start).toFixed(2),
        });
        return receipt;
    }

    // Deploy (già eseguito sopra, aggiungiamo il dato)
    latencyMetrics.push({
        "Operazione": "Deploy DocumentRegistry (Proxy UUPS)",
        "Gas Used": Number(deployReceipt.gasUsed).toLocaleString("it-IT"),
        "Latenza (ms)": (endDeploy - startDeploy).toFixed(2),
    });

    await measureTx("Mint Governance Token (SBT)",
        governance.mint(deployer.address)); // quarto token, solo per misurare

    await measureTx("Register DID (Banca)",
        didRegistry.connect(bank).registerDID(
            ethers.encodeBytes32String("did:aml:banca_x"),
            ethers.toUtf8Bytes("0xPublicKeyMock"),
            ethers.toUtf8Bytes("https://api.banca.it")
        ));

    await measureTx("Propose Bank Onboarding",
        policyManager.connect(uif).proposeBankOnboarding(bank.address));

    await measureTx("Vote (avvia Timelock 48h)",
        policyManager.connect(ade).vote(0));

    const mockNewImpl = ethers.Wallet.createRandom().address;
    const targetProxy = await docRegistry.getAddress();

    await measureTx("Propose Upgrade UUPS (1/3)",
        policyManager.connect(uif).proposeUpgrade(targetProxy, mockNewImpl));
    await measureTx("Vote Upgrade (2/3)",
        policyManager.connect(ade).voteUpgrade(0));
    await measureTx("Vote Upgrade (3/3 — unanimità, avvia Timelock)",
        policyManager.connect(gdf).voteUpgrade(0));

    const bankCredId = ethers.id("VC-AUTH-BANCA-001");
    await measureTx("Issue Verifiable Credential",
        credRegistry.connect(uif).issueCredential(bankCredId, bank.address, ethers.id("HASH")));

    const dek = CryptoEngine.generateDEK();
    const dekCommitment = CryptoEngine.computeDEKCommitment(dek);
    const dossierId = ethers.id("DOSSIER-BENCHMARK-01");

    await measureTx("Submit Dossier (con DEK Commitment)",
        docRegistry.connect(bank).submitDossier(
            dossierId, bankCredId, uif.address,
            ethers.toUtf8Bytes("ipfs://mockCID"),
            ethers.toUtf8Bytes("0xEncryptedDEK"),
            dekCommitment
        ));

    const newDekCommitment = CryptoEngine.computeDEKCommitment(CryptoEngine.generateDEK());
    await measureTx("Transition Dossier → FISCAL_REVIEW (con DEK Commitment)",
        docRegistry.connect(uif).transitionDossier(
            dossierId, 2, ade.address,
            ethers.toUtf8Bytes("ipfs://mockCID_v2"),
            ethers.toUtf8Bytes("0xEncryptedDEK_v2"),
            newDekCommitment
        ));

    const delegationId = ethers.id("DELEGA-TEST-01");
    await measureTx("Delegate Access (TTL + depth check)",
        delegationManager.connect(ade).delegateAccess(
            delegationId, dossierId, uifProvinciale.address, 86400, ethers.ZeroHash
        ));
    await measureTx("Revoke Delegation (normale)",
        delegationManager.connect(ade).revokeDelegation(delegationId));

    const emergencyDelegId = ethers.id("DELEGA-EMERGENCY-01");
    await delegationManager.connect(ade).delegateAccess(
        emergencyDelegId, dossierId, uifProvinciale.address, 86400, ethers.ZeroHash
    ).then((tx: any) => tx.wait());
    await measureTx("Emergency Revoke (Fast-Track, Core Authority)",
        delegationManager.connect(ade).emergencyRevoke(
            emergencyDelegId, "Benchmark: test revoca d'emergenza"
        ));

    console.log("Latency & Gas per operazione:");
    console.table(latencyMetrics);

    // SEZIONE B — THROUGHPUT (transazioni/secondo sul ciclo submit)
    console.log("\nSEZIONE B: THROUGHPUT\n");
    console.log("Misura: N submit di dossier in sequenza — TPS = N / tempo_totale\n");

    const N_DOSSIERS = 5;
    const throughputMetrics: any[] = [];

    // Pre-emissione di N credenziali (una per dossier)
    for (let i = 0; i < N_DOSSIERS; i++) {
        const credId = ethers.id(`VC-THROUGHPUT-${i}`);
        await credRegistry.connect(uif)
            .issueCredential(credId, bank.address, ethers.id(`HASH-${i}`))
            .then((tx: any) => tx.wait());
    }

    // Submit N dossier in sequenza, misura tempo totale
    const tpStart = performance.now();
    for (let i = 0; i < N_DOSSIERS; i++) {
        const d = CryptoEngine.generateDEK();
        const dc = CryptoEngine.computeDEKCommitment(d);
        const dId = ethers.id(`DOSSIER-TP-${i}`);
        const cId = ethers.id(`VC-THROUGHPUT-${i}`);

        const t0 = performance.now();
        const tx = await docRegistry.connect(bank).submitDossier(
            dId, cId, uif.address,
            ethers.toUtf8Bytes("ipfs://mockCID"),
            ethers.toUtf8Bytes("0xEncryptedDEK"),
            dc
        );
        const receipt = await tx.wait();
        const t1 = performance.now();

        throughputMetrics.push({
            "Dossier #": i + 1,
            "Gas Used": Number(receipt.gasUsed).toLocaleString("it-IT"),
            "Latenza (ms)": (t1 - t0).toFixed(2),
        });
    }
    const tpEnd = performance.now();
    const totalSec = (tpEnd - tpStart) / 1000;
    const tps = (N_DOSSIERS / totalSec).toFixed(2);
    const avgLatency = ((tpEnd - tpStart) / N_DOSSIERS).toFixed(2);

    console.table(throughputMetrics);
    console.log(`Riepilogo Throughput:`);
    console.log(`  Dossier sottomessi:   ${N_DOSSIERS}`);
    console.log(`  Tempo totale:         ${totalSec.toFixed(3)} s`);
    console.log(`  Throughput:           ${tps} tx/s`);
    console.log(`  Latenza media/tx:     ${avgLatency} ms`);

    // SEZIONE C — STORAGE OVERHEAD (byte a ogni layer)
    console.log("\nSEZIONE C: STORAGE OVERHEAD\n");
    console.log("Misura: byte originali → payload IPFS → calldata on-chain\n");

    // Genera una coppia RSA-2048 reale per misurare la dimensione della Busta Digitale
    const rsaKeys = CryptoEngine.generateRSAKeyPair();

    const docSizes = [512, 5_120, 51_200];   // 0.5 KB · 5 KB · 50 KB
    const storageMetrics: any[] = [];

    // CID realistico CIDv1 Helia (base32, ~59 caratteri)
    const realisticCid = "bafkreiabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstu";

    for (const size of docSizes) {
        const doc = Buffer.alloc(size, 0xAB);

        // Layer 1 — cifratura documento (AES-256-GCM)
        const { cipherText, iv, authTag } = CryptoEngine.encryptDocument(doc, dek);
        const ipfsPayload = cipherText.length + iv.length + authTag.length; // dati reali su IPFS

        // Layer 2 — Busta Digitale (RSA-2048 OAEP → sempre 256 byte → 344 char Base64)
        const wrappedKey = CryptoEngine.wrapKey(dek, rsaKeys.publicKey);
        const bustaBytesB64 = Buffer.from(wrappedKey).length;  // come passato via ethers.toUtf8Bytes

        // Layer 3 — calldata on-chain per submitDossier
        // submitDossier(bytes32, bytes32, address, bytes cid, bytes encDEK, bytes32)
        // ogni bytes-dinamico: 32B offset + 32B length + ceil(n/32)*32 contenuto
        const cidBytes = Buffer.from("ipfs://" + realisticCid).length;  // ~66 B
        const encDekBytes = bustaBytesB64;                                  // ~344 B

        const calldataSize =
            4 +                                       // selector
            32 + 32 + 32 +                            // dossierId, bankCredId, targetAuthority
            32 + Math.ceil(cidBytes / 32) * 32 +   // bytes cid (offset + data)
            32 + Math.ceil(encDekBytes / 32) * 32 +   // bytes encDEK (offset + data)
            32;                                       // dekCommitment (bytes32 fisso)

        const overheadRatio = (calldataSize / size * 100).toFixed(1);

        storageMetrics.push({
            "Doc originale": formatBytes(size),
            "Payload IPFS": formatBytes(ipfsPayload),
            "di cui: IV + AuthTag": "28 B",
            "Busta Digitale (B64)": formatBytes(bustaBytesB64),
            "dekCommitment on-chain": "32 B",
            "Calldata on-chain": formatBytes(calldataSize),
            "On-chain / Doc (%)": overheadRatio + " %",
        });
    }

    console.table(storageMetrics);

    console.log("\nNota: il contenuto del documento non transita mai on-chain.");
    console.log("La calldata on-chain è ~costante indipendentemente dalla dimensione del documento:");
    console.log("  CID IPFS: ~66 B (fisso) · Busta Digitale RSA-2048: ~344 B (fisso) · dekCommitment: 32 B (fisso)\n");

    // RIEPILOGO FINALE
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("   RIEPILOGO RISULTATI");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`  [A] Sezione Latency & Gas   → vedi tabella Sezione A`);
    console.log(`  [B] Throughput (submit)     → ${tps} tx/s  (latenza media ${avgLatency} ms)`);
    console.log(`  [C] On-chain footprint      → costante ~${formatBytes(
        4 + 32 + 32 + 32 +
        32 + Math.ceil(Buffer.from("ipfs://bafkreiabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstu").length / 32) * 32 +
        32 + Math.ceil(344 / 32) * 32 +
        32
    )} (indip. dalla dimensione del documento)`);
    console.log("\n");
}

main().catch((error) => {
    console.error("Errore durante il benchmark:", error);
    process.exitCode = 1;
});
