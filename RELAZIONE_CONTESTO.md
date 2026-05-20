# Contesto Tecnico per la Relazione — Framework AML/CFT su Blockchain

Questo documento descrive in modo esaustivo l'architettura, le scelte implementative e il funzionamento del progetto. È pensato per essere passato a un'AI che dovrà redigere una relazione tecnica formale.

---

## 1. Obiettivo del Progetto

Il progetto implementa un framework decentralizzato per la lotta al riciclaggio di denaro e al finanziamento del terrorismo (Anti-Money Laundering / Counter-Financing of Terrorism, AML/CFT). Il sistema orchestra il passaggio di informazioni investigative riservate tra istituti bancari e tre autorità istituzionali italiane: l'Unità di Informazione Finanziaria (UIF), l'Agenzia delle Entrate (AdE) e la Guardia di Finanza (GdF).

Il problema centrale che il sistema risolve è il seguente: come far transitare un fascicolo investigativo sensibile tra enti diversi, garantendo che i dati siano leggibili solo dall'ente di competenza in quel preciso momento, che nessun attore possa alterare retroattivamente la storia del fascicolo, e che l'intera catena di custodia sia verificabile e non ripudiabile.

---

## 2. Stack Tecnologico

- **Linguaggio Smart Contract:** Solidity ^0.8.28
- **Framework di sviluppo:** Hardhat con TypeScript
- **Librerie Smart Contract:** OpenZeppelin Contracts Upgradeable v5 (pattern UUPS)
- **Layer off-chain / SDK:** TypeScript con Ethers.js v6
- **Storage decentralizzato:** IPFS tramite Helia (implementazione JavaScript di IPFS), con persistenza su filesystem locale (`FsBlockstore`, `FsDatastore`)
- **Crittografia:** modulo nativo `node:crypto` di Node.js
- **Test:** Mocha + Chai + Hardhat Network Helpers (28 test, tutti verdi)
- **Rete target:** EVM-compatible (testata su Hardhat Network locale)

---

## 3. Architettura dei Smart Contract

Il sistema è composto da sei smart contract, tutti deployati come proxy UUPS aggiornabili.

### 3.1 GovernanceToken.sol — Soulbound NFT

Implementa un token ERC-721 non trasferibile (Soulbound Token, SBT). Viene mintato una sola volta per ciascuna delle tre Autorità Core durante la fase di inizializzazione del sistema ("Big Bang"). Il possesso di questo token è la condizione necessaria e sufficiente per partecipare alle votazioni di governance.

La non trasferibilità è implementata sovrascrivendo la funzione interna `_update` di OpenZeppelin v5: se `from != address(0)` (non è un minting) e `to != address(0)` (non è un burning), la transazione viene revertita con `SoulboundTransferBlocked`. Ogni indirizzo può possedere al massimo un token (`AlreadyHasToken`).

### 3.2 DIDRegistry.sol — Registro delle Identità Decentralizzate

Implementa un registro on-chain di Decentralized Identifiers (DID) conforme al modello W3C DID. Ogni attore (banca, UIF, AdE, GdF) registra un DID univoco (es. `did:aml:uif`) associato alla propria chiave pubblica RSA e a un service endpoint.

La struttura `DIDDocument` contiene: indirizzo owner, chiave pubblica in formato PEM (come `bytes`), service endpoint, timestamp di creazione e aggiornamento, flag `active`. Le funzioni principali sono `registerDID`, `resolveDID`, `updateDID`, `revokeDID` e `isActive`. La chiave pubblica registrata qui è quella usata per cifrare le Buste Digitali nel flusso crittografico.

### 3.3 CredentialRegistry.sol — Registro delle Verifiable Credentials

Gestisce l'emissione, la lettura e la revoca di Verifiable Credentials (VC) on-chain. Una VC è una struttura con: emittente (`issuer`), soggetto (`subject`), hash del documento JSON off-chain (`credentialHash`), timestamp di emissione, flag `revoked`.

Solo l'emittente originale può revocare una propria credenziale. La funzione `verifyCredential` restituisce `true` solo se la credenziale esiste e non è revocata. Questo contratto è usato dal `DocumentRegistry` per verificare che una banca sia autorizzata prima di accettare una Segnalazione di Operazione Sospetta (SOS).

### 3.4 PolicyManager.sol — Motore di Governance

È il contratto più complesso dal punto di vista della governance. Gestisce due tipologie di proposte con quorum differenti.

**Membership Policy — Quorum 2/3 + Timelock 48 ore:**
Regola l'ingresso di nuove banche nel sistema. Il flusso è: una Core Authority propone (`proposeBankOnboarding`), le altre votano (`vote`). Al raggiungimento di 2 voti su 3 viene salvato il timestamp `quorumReachedAt` e viene emesso l'evento `QuorumReached(proposalId, executableAfter)`. La proposta NON viene eseguita immediatamente. Solo dopo 48 ore chiunque può chiamare `executeProposal(proposalId)`, che emette `BankOnboarded`. Se chiamata prima, lancia `TimelockNotExpired`.

**System Upgrade Policy — Unanimità 3/3 + Timelock 48 ore:**
Regola l'aggiornamento del codice dei contratti proxy UUPS. Il flusso è: `proposeUpgrade(targetProxy, newImplementation)` → `voteUpgrade(id)` per ciascuna delle tre autorità → `executeUpgrade(id)` dopo 48 ore. L'unanimità è obbligatoria: con soli 2 voti il campo `quorumReachedAt` rimane a 0 e `executeUpgrade` lancia `UnanimityRequired`. Con 3 voti parte il Timelock. `executeUpgrade` chiama `upgradeToAndCall` sul proxy target tramite l'interfaccia `IUUPSUpgradeable`.

Il modificatore `onlyAuthority` verifica che il chiamante possieda almeno un Governance Token. La costante pubblica `CORE_AUTHORITY_COUNT = 3` rende esplicita la soglia di unanimità.

### 3.5 DocumentRegistry.sol — Macchina a Stati del Dossier

È il contratto centrale del sistema. Implementa una Macchina a Stati Finiti (FSM) per i fascicoli investigativi.

**Enum DossierState:** `SUBMITTED(0)`, `UNDER_ANALYSIS(1)`, `FISCAL_REVIEW(2)`, `IN_INVESTIGATION(3)`, `ARCHIVED(4)`.

**Struct Dossier:**
```
submitter       — indirizzo della banca che ha inviato la SOS
currentHandler  — indirizzo dell'autorità attualmente in carico
state           — stato corrente (enum DossierState)
ipfsCid         — CID IPFS del documento cifrato (come bytes)
encryptedDEK    — Busta Digitale: DEK cifrata con la chiave pubblica dell'handler (come bytes, Base64)
dekCommitment   — SHA-256(DEK) in chiaro, notarizzato on-chain (bytes32)
lastUpdated     — timestamp dell'ultimo aggiornamento
```

**submitDossier:** La banca invia la SOS. Verifica che la banca abbia una VC valida nel `CredentialRegistry` e che la VC appartenga al chiamante. Richiede un `dekCommitment` non nullo. Imposta lo stato a `SUBMITTED` e assegna la UIF come `currentHandler`.

**transitionDossier:** L'autorità in carico fa avanzare il dossier. Verifica che il chiamante sia il `currentHandler`. Blocca esplicitamente le transizioni su dossier in stato `ARCHIVED` (custom error `DossierArchived`). Impone la progressione unidirezionale degli stati (`uint8(newState) <= uint8(d.state)` → `InvalidStateTransition`). Aggiorna CID, Busta Digitale e Key Commitment.

Entrambe le funzioni emettono eventi che includono il `dekCommitment`, costruendo un audit trail crittograficamente verificabile.

### 3.6 DelegationManager.sol — Gestione Deleghe e Access Control

Gestisce le deleghe operative temporanee che le Autorità Core possono emettere verso uffici periferici o periti forensi.

**Struct Delegation:**
```
delegator          — chi concede la delega
delegatee          — chi riceve la delega
dossierId          — fascicolo di riferimento
expiryTime         — timestamp di scadenza (block.timestamp + TTL)
active             — flag di revoca
parentDelegationId — ID della delega padre (per sub-deleghe)
depth              — profondità nella catena (0 = emessa da Core Authority)
```

**Costante MAX_DELEGATION_DEPTH = 2:** Limita la catena di sub-deleghe a tre livelli (0, 1, 2). Un tentativo di creare una delega di livello 3 lancia `MaxDepthExceeded`. Questo previene catene arbitrariamente lunghe che potrebbero causare out-of-gas nella ricorsione di `checkAccess`.

**delegateAccess:** Crea una delega con TTL. Verifica che il chiamante sia il `currentHandler` del dossier o un delegato valido (tramite `checkAccess`). Calcola la profondità della nuova delega in base alla profondità del padre.

**checkAccess (Lazy Revocation):** Funzione `view` ricorsiva che verifica la validità di una delega risalendo la catena padre-figlio. Controlla: flag `active`, scadenza TTL, corrispondenza `delegatee` e `dossierId`. La revoca è "pigra": non propaga attivamente ma viene ricalcolata on-demand solo al momento dell'accesso, senza sprecare gas in propagazioni attive.

**revokeDelegation:** Revoca manuale da parte del delegante originale.

**emergencyRevoke (Emergency Policy):** Permette a una singola Core Authority di revocare d'urgenza una delega nel proprio dominio, bypassando il quorum. Verifica che il chiamante sia una Core Authority (`isCoreAuthority` mapping, popolato nell'`initialize`) e che sia il delegante diretto o un antenato nella catena (`_isAncestorOrDelegator`). Emette obbligatoriamente sia `DelegationRevoked` che `EmergencyActionTaken(delegationId, authority, justification, timestamp)` per garantire la tracciabilità nell'audit trail.

**logDispute (Key Commitment Dispute):** Permette all'handler corrente di segnalare un'anomalia crittografica. Emette `DisputeLogged(dossierId, reporter, reason, onChainCommitment)` dove `onChainCommitment` è il `dekCommitment` notarizzato on-chain. Questo fornisce la prova matematica per identificare chi ha inserito la chiave sbagliata: se `SHA-256(DEK_decifrata) != onChainCommitment`, la responsabilità è dell'autorità che ha eseguito il re-wrapping precedente.

---

## 4. Layer Off-Chain — SDK TypeScript

### 4.1 utils/crypto-utils.ts — CryptoEngine

Implementa il pattern crittografico ibrido "Busta Digitale" usando il modulo nativo `node:crypto`.

**generateRSAKeyPair():** Genera una coppia di chiavi RSA-2048 in formato PEM (SPKI per la pubblica, PKCS8 per la privata). Usata per popolare il campo `publicKey` nel DIDRegistry.

**generateDEK():** Genera 32 byte casuali (256 bit) come Data Encryption Key monouso per AES-256.

**encryptDocument(fileBuffer, dek):** Cifra un documento con AES-256-GCM. Genera un IV casuale di 12 byte. Restituisce `{ cipherText, iv, authTag }`.

**decryptDocument(encryptedPayload, dek):** Decifra un documento AES-256-GCM verificando l'authentication tag.

**wrapKey(dek, recipientPublicKey):** Cifra la DEK con la chiave pubblica RSA del destinatario usando RSA-OAEP con SHA-256. Restituisce la Busta Digitale in formato Base64.

**unwrapKey(encryptedDEKBase64, recipientPrivateKey):** Decifra la Busta Digitale con la chiave privata RSA del destinatario, recuperando la DEK originale.

**computeDEKCommitment(dek):** Calcola `SHA-256(DEK)` e lo restituisce come stringa esadecimale con prefisso `0x`, compatibile con il tipo `bytes32` di Solidity. Deve essere chiamato PRIMA del key wrapping.

**verifyDEKCommitment(dek, onChainCommitment):** Confronta `SHA-256(DEK_decifrata)` con il commitment on-chain. Restituisce `true` se corrispondono.

### 4.2 utils/helia-node.ts — Nodo IPFS

Gestisce un nodo IPFS locale basato su Helia (implementazione JavaScript di IPFS). Usa `FsBlockstore` e `FsDatastore` per la persistenza su filesystem nella cartella `.ipfs/`. Il nodo viene avviato con `start: false` (senza networking libp2p) per uso in ambiente di laboratorio.

Il modulo usa un workaround tecnico necessario: TypeScript con `"module": "commonjs"` converte gli `import()` dinamici in `require()`, che Node.js rifiuta per i moduli ESM puri come Helia. La soluzione è usare `new Function('modulePath', 'return import(modulePath)')` per forzare il vero `import()` nativo di Node.js.

### 4.3 services/DIDService.ts

Astrae le operazioni sul DIDRegistry. `registerDID` converte il DID stringa in `bytes32` con `ethers.encodeBytes32String` e la chiave pubblica in `bytes` con `ethers.toUtf8Bytes`. `resolveDID` interroga il contratto e riconverte i campi `bytes` in stringhe leggibili.

### 4.4 services/CredentialService.ts

Astrae le operazioni di governance per l'onboarding delle banche e l'emissione di VC. `onboardBank` chiama `proposeBankOnboarding` (UIF) e `vote` (AdE) in sequenza. `issueCredential` usa `ethers.id` per calcolare l'hash keccak256 dell'ID credenziale e del contenuto.

### 4.5 services/StorageService.ts

Astrae le operazioni IPFS. `uploadDocument` chiama `addFile` del nodo Helia e restituisce il CID nel formato `ipfs://[CID]`. `shutdown` ferma il nodo Helia in modo pulito.

### 4.6 services/DossierService.ts — Orchestratore del Flusso Crittografico

È il servizio più importante del layer off-chain. Coordina crittografia, IPFS e blockchain.

**createAndSubmitDossier:**
1. Genera una DEK monouso con `CryptoEngine.generateDEK()`
2. Cifra il documento con AES-256-GCM
3. Calcola il Key Commitment: `dekCommitment = SHA-256(DEK)` — PRIMA del wrapping
4. Carica il documento cifrato su IPFS, ottiene il CID
5. Risolve il DID del destinatario (UIF) per ottenere la sua chiave pubblica RSA
6. Crea la Busta Digitale: cifra la DEK con la chiave pubblica del destinatario (RSA-OAEP)
7. Chiama `submitDossier` on-chain passando CID, Busta Digitale e `dekCommitment`

**reviewAndForwardDossier:**
1. Recupera i metadati del dossier on-chain (CID, encryptedDEK, dekCommitment)
2. Apre la Busta Digitale con la chiave privata dell'handler corrente
3. **Verifica il Key Commitment:** confronta `SHA-256(DEK_decifrata)` con `dekCommitment` on-chain. Se divergono, lancia un errore con istruzioni per chiamare `logDispute()`
4. Ri-cifra il documento aggiornato con la stessa DEK
5. Carica il nuovo documento su IPFS
6. Risolve il DID del prossimo destinatario
7. Crea la nuova Busta Digitale (Re-Wrapping JIT) per il prossimo destinatario
8. Calcola il nuovo `dekCommitment`
9. Chiama `transitionDossier` on-chain con il nuovo CID, la nuova Busta Digitale e il nuovo `dekCommitment`

---

## 5. Meccanismi di Sicurezza Chiave

### 5.1 Crittografia Ibrida e Buste Digitali Just-In-Time (JIT)

Il documento investigativo viene cifrato simmetricamente con AES-256-GCM usando una DEK monouso. La DEK viene poi cifrata asimmetricamente con RSA-OAEP usando la chiave pubblica del destinatario, creando la "Busta Digitale". Le Buste Digitali vengono generate e distribuite solo nel momento in cui avviene il passaggio formale di stato on-chain (modello JIT): un'autorità non può decifrare i documenti prima del proprio turno perché la Busta Digitale per lei viene creata solo quando l'autorità precedente esegue la transizione.

### 5.2 Key Commitment — Verifica di Integrità

Il campo `dekCommitment` (SHA-256 della DEK in chiaro) viene notarizzato on-chain alla fonte, prima che la DEK venga cifrata nella Busta Digitale. Questo crea un legame crittografico verificabile: il ricevente, dopo aver aperto la busta, ricalcola SHA-256 della DEK decifrata e confronta con il valore on-chain. Se divergono, ha la prova matematica che la busta è stata manomessa e può chiamare `logDispute()` allegando questa evidenza. L'evento `DisputeLogged` include il `dekCommitment` on-chain, rendendo la disputa verificabile da qualsiasi osservatore.

### 5.3 Lazy Revocation

La revoca delle deleghe non propaga attivamente a cascata (il che consumerebbe gas proporzionale alla dimensione dell'albero). Invece, il sistema aggiorna un solo record (`active = false`). La validità dell'intero albero gerarchico viene ricalcolata dinamicamente dalla funzione `checkAccess` solo nel momento in cui un utente tenta di accedere, risalendo ricorsivamente la catena padre-figlio.

### 5.4 Emergency Policy

In situazioni di rischio immediato (es. un perito forense risulta compromesso), una singola Core Authority può revocare d'urgenza una delega nel proprio dominio senza attendere il quorum delle altre autorità. L'azione è vincolata al proprio dominio (verificato da `_isAncestorOrDelegator`) e viene registrata inderogabilmente nell'audit trail on-chain tramite l'evento `EmergencyActionTaken`, che include l'identità dell'autorità, la motivazione e il timestamp.

### 5.5 Governance Stratificata con Timelock

Le decisioni istituzionali richiedono quorum differenti in base alla loro criticità:
- **Membership Policy** (onboarding banche): 2/3 dei voti + Timelock 48 ore. Il Timelock previene abusi e dà tempo alle autorità di rilevare proposte fraudolente prima dell'esecuzione.
- **System Upgrade Policy** (aggiornamento codice contratti): unanimità 3/3 + Timelock 48 ore. L'unanimità elimina il rischio di collusione tra due autorità per imporre un upgrade malevolo.

### 5.6 Architettura Ibrida Blockchain + IPFS

I dati sensibili non transitano mai in chiaro sulla blockchain. Il flusso è: documento cifrato → IPFS (off-chain), CID + Busta Digitale + Key Commitment → blockchain (on-chain). La blockchain garantisce l'immutabilità dei metadati e della catena di custodia; IPFS garantisce la disponibilità dei dati cifrati.

### 5.7 Pattern UUPS (Universal Upgradeable Proxy Standard)

Tutti i contratti sono deployati come proxy UUPS di OpenZeppelin. Questo permette di aggiornare la logica applicativa preservando lo stato on-chain e gli indirizzi proxy. La funzione `_authorizeUpgrade` è protetta da `onlyOwner`; in produzione l'owner dei proxy deve essere trasferito al `PolicyManager` per attivare il controllo di unanimità 3/3.

---

## 6. Flusso Operativo Completo (Lifecycle di un Dossier)

**Fase 0 — Inizializzazione del sistema:**
Il deployer minta i Governance Token (SBT) a UIF, AdE e GdF. Ogni ente registra il proprio DID e la propria chiave pubblica RSA nel DIDRegistry.

**Fase 1 — Onboarding della banca:**
La UIF propone l'ingresso della banca nel sistema (`proposeBankOnboarding`). L'AdE vota a favore. Il quorum 2/3 viene raggiunto e il Timelock di 48 ore viene avviato. Dopo 48 ore, `executeProposal` viene chiamata e la banca è autorizzata. La UIF emette una Verifiable Credential per la banca nel CredentialRegistry.

**Fase 2 — Creazione della SOS (stato: SUBMITTED):**
La banca rileva un'operazione sospetta. Genera una DEK, cifra il documento, calcola il Key Commitment, carica il documento cifrato su IPFS, crea la Busta Digitale per la UIF e chiama `submitDossier`. Il dossier è ora in stato `SUBMITTED` con `currentHandler = UIF`.

**Fase 3 — Triage UIF (stato: UNDER_ANALYSIS → FISCAL_REVIEW):**
La UIF apre la Busta Digitale con la propria chiave privata, verifica il Key Commitment, decifra il documento, esegue il triage, aggiorna il documento con le proprie valutazioni, lo ri-cifra, crea la nuova Busta Digitale per l'AdE e chiama `transitionDossier`. Il dossier passa a `FISCAL_REVIEW` con `currentHandler = AdE`.

**Fase 4 — Revisione fiscale AdE (stato: FISCAL_REVIEW → IN_INVESTIGATION):**
L'AdE ripete il processo: apre la busta, verifica il commitment, esegue i controlli tributari, aggiorna il documento, crea la Busta Digitale per la GdF e transiziona a `IN_INVESTIGATION`.

**Fase 5 — Indagine GdF (stato: IN_INVESTIGATION → ARCHIVED):**
La GdF coordina le indagini, allega verbali e perizie, redige il report finale e archivia il dossier (`ARCHIVED`). Da questo momento il dossier è di sola lettura: qualsiasi tentativo di transizione lancia `DossierArchived`.

**Fase opzionale — Delega operativa:**
In qualsiasi fase, l'autorità in carico può delegare l'accesso a un ufficio periferico con un TTL. La GdF può delegare un Comando Provinciale (livello 1), che può sub-delegare un perito forense (livello 2). Tentativi di sub-delega oltre il livello 2 vengono bloccati. Se il perito risulta compromesso, la GdF può revocarlo d'urgenza con `emergencyRevoke`.

---

## 7. Suite di Test (28 test, tutti verdi)

### DocumentRegistry.test.ts (7 test)
- Invio dossier con VC valida: verifica stato on-chain e `dekCommitment` salvato
- Blocco invio senza VC valida (`BankNotAuthorized`)
- Blocco invio con `dekCommitment == bytes32(0)` (`InvalidDEKCommitment`)
- Transizione di stato con re-wrapping: verifica nuovo handler, stato e `dekCommitment`
- Blocco transizione da autorità non in carico (`NotDossierHandler`)
- Blocco regressione di stato (`InvalidStateTransition`)
- Blocco transizione su dossier `ARCHIVED` (`DossierArchived`)

### DelegationManager.test.ts (10 test)
- Delega da parte del gestore corrente: verifica accesso e `depth=0` nell'evento
- Blocco delega da autorità non in carico (`NotAuthorizedToDelegate`)
- Blocco sub-delega oltre `MAX_DELEGATION_DEPTH` (`MaxDepthExceeded`)
- Lazy Revocation per scadenza TTL
- Revoca manuale da parte del delegante
- Emergency Revoke da Core Authority nel proprio dominio
- Blocco Emergency Revoke da non-Core Authority (`NotCoreAuthority`)
- Blocco Emergency Revoke da Core Authority fuori dominio (`NotAuthorizedToDelegate`)
- Disputa con Key Commitment: verifica che l'evento includa il `dekCommitment` on-chain
- Blocco disputa da utente non autorizzato (`OnlyHandlerCanDispute`)

### PolicyManager.test.ts (11 test)
- Assegnazione corretta dei Soulbound Token alle tre autorità
- Proposta onboarding banca con voto automatico del proponente
- Blocco proposta da non-autorità (`AccessDeniedNotAuthority`)
- Quorum 2/3 avvia Timelock senza eseguire immediatamente (verifica `QuorumReached`, assenza di `BankOnboarded`)
- Blocco `executeProposal` prima delle 48 ore (`TimelockNotExpired`)
- Esecuzione corretta dopo 48 ore (`BankOnboarded`)
- Blocco doppio voto membership (`AlreadyVoted`)
- Flusso upgrade: proposta + 3 voti → `UpgradeUnanimityReached`
- Blocco upgrade con solo 2 voti (`UnanimityRequired`)
- Blocco `executeUpgrade` prima del Timelock (`UpgradeTimelockNotExpired`)
- Blocco doppio voto upgrade (`AlreadyVoted`)

---

## 8. Script Operativi

### scripts/simulation.ts
Esegue una simulazione end-to-end completa su rete Hardhat locale:
1. Deploy di tutti i contratti proxy UUPS
2. Minting dei Governance Token alle tre autorità
3. Registrazione DID e chiavi RSA per UIF, AdE e banca
4. Onboarding della banca con quorum 2/3 (Timelock mostrato ma non atteso in ambiente di test)
5. Emissione VC per la banca
6. Creazione dossier con Key Commitment e upload su IPFS reale (Helia)
7. Verifica del `dekCommitment` on-chain
8. Triage UIF con verifica Key Commitment e re-wrapping per AdE
9. Dimostrazione della firma `emergencyRevoke`

### scripts/benchmark.ts
Misura il costo in gas e il tempo di esecuzione (ms) di ogni operazione on-chain, incluse le nuove operazioni aggiunte: Submit Dossier con DEK Commitment, Transition Dossier con DEK Commitment, Propose/Vote Upgrade (×3), Emergency Revoke.

---

## 9. Struttura del Repository

```
contracts/
  GovernanceToken.sol       — Soulbound NFT per il voto di governance
  DIDRegistry.sol           — Registro DID e chiavi pubbliche RSA
  CredentialRegistry.sol    — Emissione e revoca Verifiable Credentials
  PolicyManager.sol         — Governance: quorum 2/3 + Timelock, unanimità 3/3 + Timelock
  DocumentRegistry.sol      — FSM del dossier + Key Commitment
  DelegationManager.sol     — Deleghe TTL, Lazy Revocation, Emergency Policy

services/
  DIDService.ts             — Astrazione operazioni DIDRegistry
  CredentialService.ts      — Astrazione onboarding banche e emissione VC
  StorageService.ts         — Astrazione upload IPFS
  DossierService.ts         — Orchestratore flusso crittografico completo
  index.ts                  — Re-export dei servizi

utils/
  crypto-utils.ts           — CryptoEngine: AES-256-GCM, RSA-OAEP, Key Commitment
  helia-node.ts             — Nodo IPFS locale con persistenza filesystem

scripts/
  simulation.ts             — Simulazione end-to-end
  benchmark.ts              — Benchmark gas e latenza
  deploy.ts                 — Script di deploy

test/
  DocumentRegistry.test.ts  — 7 test
  DelegationManager.test.ts — 10 test
  PolicyManager.test.ts     — 11 test
```

---

## 10. Dipendenze Principali

```json
{
  "@openzeppelin/contracts": "^5.x",
  "@openzeppelin/contracts-upgradeable": "^5.x",
  "@openzeppelin/hardhat-upgrades": "^3.x",
  "hardhat": "^2.x",
  "ethers": "^6.x",
  "helia": "ESM puro",
  "@helia/unixfs": "ESM puro",
  "blockstore-fs": "ESM puro",
  "datastore-fs": "ESM puro"
}
```

Nota tecnica: Helia e le sue dipendenze sono moduli ESM puri, incompatibili con il sistema di moduli CommonJS usato da Hardhat/TypeScript. Il workaround implementato in `helia-node.ts` usa `new Function('modulePath', 'return import(modulePath)')` per forzare il vero `import()` dinamico nativo di Node.js, aggirando la transpilazione di TypeScript.
