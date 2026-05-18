# Blockchain Anti-Evasione (AML/CFT Framework)

Questo progetto implementa un'architettura decentralizzata sicura per la lotta al riciclaggio e al finanziamento del terrorismo (AML/CFT). Fornisce un ecosistema basato su Blockchain e IPFS in grado di orchestrare il passaggio di informazioni riservate tra Banche, Unità di Informazione Finanziaria (UIF), Agenzia delle Entrate (AdE) e Guardia di Finanza (GdF).

L'architettura garantisce la **non ripudiabilità**, l'**integrità dei dati** e la **privacy assoluta** attraverso l'uso del pattern crittografico della "Busta Digitale" (Digital Envelope) e di un sistema di Identità Decentralizzata (DID).

## Architettura del Sistema

Il framework si divide in tre componenti principali:

1. **Smart Contracts (Solidity + UUPS Proxies)**
   - `GovernanceToken.sol`: Un token Soulbound (non trasferibile) usato per identificare in modo univoco le Autorità primarie.
   - `DIDRegistry.sol`: Un registro on-chain delle Identità Decentralizzate e delle relative chiavi pubbliche RSA.
   - `PolicyManager.sol` & `CredentialRegistry.sol`: Gestiscono i quorum di voto istituzionale per autorizzare (tramite Verifiable Credentials) l'ingresso di nuove Banche nel sistema.
   - `DocumentRegistry.sol`: Traccia l'hash e lo stato crittografico dei Dossier investigativi, le transizioni di stato e le Buste Digitali.

2. **Servizi Off-Chain (SDK TypeScript)**
   - I servizi nella cartella `services/` (`DIDService`, `CredentialService`, `StorageService`, `DossierService`) fungono da layer di astrazione. Trasformano la complessa interazione con la crittografia, IPFS e la blockchain in semplici comandi orientati agli oggetti.

3. **Storage & Crittografia**
   - **IPFS (Helia):** Viene utilizzato per memorizzare fisicamente i file in modo decentralizzato.
   - **Hybrid Crypto:** I dossier sensibili (es. Segnalazioni di Operazioni Sospette) vengono cifrati localmente con una chiave simmetrica usa-e-getta (AES-256-GCM). La chiave viene poi cifrata (Key Wrapping) usando la chiave pubblica RSA (RSA-OAEP) del destinatario, creando una Busta Digitale che viene salvata sulla Blockchain.

## Prerequisiti

- [Node.js](https://nodejs.org/en/) (versione 18+ consigliata)
- `npm`

## Installazione

1. Clona il repository.
2. Installa le dipendenze:
   ```bash
   npm install
   ```

*Nota: Il progetto è configurato appositamente per gestire in modo sicuro un mix di moduli CommonJS (Hardhat) ed ESM puri (IPFS/Helia) senza conflitti.*

## Comandi Principali

### 1. Pulizia dell'ambiente
Pulisce la cache di compilazione e le cartelle auto-generate (come `typechain-types`):
```bash
npm run clean
```

### 2. Compilazione degli Smart Contract
Compila tutti i contratti Solidity in bytecode EVM. Necessario la prima volta o dopo aver modificato un contratto `.sol`:
```bash
npx hardhat compile
```

### 3. Simulazione End-To-End (Consigliata)
Questo è il modo migliore per testare l'intera architettura. Lo script avvia una rete locale in memoria, esegue il deploy dei contratti Proxy UUPS, registra gli attori, crea una segnalazione anomala cifrata, la carica su IPFS e la fa passare tra Banca, UIF e AdE in modo completamente sicuro.

```bash
npx hardhat run scripts/simulation.ts
```

## Sicurezza
Questo framework utilizza contratti aggiornabili **UUPS (Universal Upgradeable Proxy Standard)** di OpenZeppelin. Questo significa che l'architettura logica può essere migliorata o corretta nel tempo preservando però i dati immutabili e gli indirizzi proxy originali.