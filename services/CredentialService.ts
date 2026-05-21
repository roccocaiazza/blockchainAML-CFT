import { ethers } from "ethers";

// Documento privato completo della VC. Non va mai on-chain.
export interface VerifiableCredential {
    id: string;
    type: string;
    issuer: string;
    subject: string;
    issuanceDate: string;
    claims: Record<string, any>; // Tutti i claims, inclusi quelli sensibili
}

// Sottoinsieme minimale della VC rivelato al verifier (Selective Disclosure).
export interface VerifiablePresentation {
    vcId: string;
    disclosedClaims: Record<string, any>; // Solo i campi selettivamente rivelati
    presentationHash: string;             // keccak256 del JSON minimale, verificabile on-chain
}

export class CredentialService {
    private credRegistry: any;
    private policyManager: any;

    constructor(credRegistryContract: any, policyManagerContract: any) {
        this.credRegistry = credRegistryContract;
        this.policyManager = policyManagerContract;
    }

    // Costruisce una Verifiable Presentation rivelando solo i campi specificati (SD-JWT semplificato).
    // Calcola keccak256 su un JSON minimale deterministico invece che sull'intera VC.
    buildSelectiveDisclosureHash(
        vc: VerifiableCredential,
        fieldsToReveal: string[]
    ): VerifiablePresentation {
        const disclosedClaims: Record<string, any> = {};

        for (const field of fieldsToReveal) {
            if (field.startsWith("claims.")) {
                const claimKey = field.slice("claims.".length);
                if (vc.claims[claimKey] !== undefined) {
                    disclosedClaims[field] = vc.claims[claimKey];
                }
            } else {
                if ((vc as any)[field] !== undefined) {
                    disclosedClaims[field] = (vc as any)[field];
                }
            }
        }

        // Chiavi ordinate alfabeticamente per garantire serializzazione deterministica
        const sortedKeys = Object.keys(disclosedClaims).sort();
        const canonicalJson = JSON.stringify(
            Object.fromEntries(sortedKeys.map(k => [k, disclosedClaims[k]]))
        );

        const presentationHash = ethers.id(canonicalJson);

        console.log(`[CredentialService] Selective Disclosure — campi rivelati: [${fieldsToReveal.join(", ")}]`);
        console.log(`[CredentialService] JSON minimale: ${canonicalJson}`);
        console.log(`[CredentialService] Presentation Hash (keccak256): ${presentationHash}`);

        return { vcId: vc.id, disclosedClaims, presentationHash };
    }

    // Verifica che una Verifiable Presentation corrisponda all'hash notarizzato on-chain.
    verifyPresentation(presentation: VerifiablePresentation, onChainHash: string): boolean {
        const sortedKeys = Object.keys(presentation.disclosedClaims).sort();
        const canonicalJson = JSON.stringify(
            Object.fromEntries(sortedKeys.map(k => [k, presentation.disclosedClaims[k]]))
        );
        const recomputedHash = ethers.id(canonicalJson);

        const isValid = recomputedHash.toLowerCase() === onChainHash.toLowerCase();
        console.log(`[CredentialService] Verifica Presentation: ${isValid ? "✓ VALIDA" : "✗ HASH MISMATCH"}`);
        return isValid;
    }

    // Propone l'onboarding di una banca e raccoglie i voti. Avvia il Timelock di 48h.
    async onboardBank(uif: ethers.Signer, ade: ethers.Signer, bankAddress: string): Promise<void> {
        console.log(`[CredentialService] Proposta onboarding per la banca: ${bankAddress}`);

        let tx = await this.policyManager.connect(uif).proposeBankOnboarding(bankAddress);
        await tx.wait();

        tx = await this.policyManager.connect(ade).vote(0);
        await tx.wait();

        console.log(`[CredentialService] Quorum 2/3 raggiunto. Timelock di 48h avviato.`);
        console.log(`[CredentialService] Chiamare executeProposal() dopo 48h per completare l'onboarding.`);
    }

    // Emette una VC con Selective Disclosure. Registra on-chain solo il presentationHash, mai i dati sensibili.
    async issueCredential(
        issuer: ethers.Signer,
        vc: VerifiableCredential,
        fieldsToReveal: string[] = ["type", "subject"]
    ): Promise<VerifiablePresentation> {
        console.log(`[CredentialService] Emissione VC con Selective Disclosure per ${vc.subject}`);
        console.log(`[CredentialService] Tipo credenziale: ${vc.type}`);

        const presentation = this.buildSelectiveDisclosureHash(vc, fieldsToReveal);

        const tx = await this.credRegistry.connect(issuer).issueCredential(
            ethers.id(vc.id),
            vc.subject,
            presentation.presentationHash
        );
        await tx.wait();

        console.log(`[CredentialService] VC ${vc.id} emessa. Hash on-chain: ${presentation.presentationHash}`);
        return presentation;
    }
}
