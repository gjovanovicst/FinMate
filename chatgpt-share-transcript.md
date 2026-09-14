# ChatGPT share: Planiranje AI budžetske aplikacije

Source: https://chatgpt.com/share/6aa7af05-21a0-83eb-88e9-614091ee8eee
Conversation ID: 6aa7af05-21a0-83eb-88e9-614091ee8eee
Created: 2026-... title: Planiranje AI budžetske aplikacije

## [0] User

Želeo bih da napravim aplikaciju kućni budžet u koju bi ugradili Ai i recimo unesem Caka prodavnica 700 ili lidl 2000 ili recimo dejan rođa 3600 da Ai to procesuira u pozadini kategoriše. Upozori na budžet. Zatim unos koji bih hteo da uštedim i alerti itd jedan malo pametan sistem sa lepim zi za desktop i mobilne uređaje

## [6] Assistant

Da — i mislim da ovo ima **mnogo više potencijala od obične aplikacije za praćenje troškova**. Ključ bi bio da korisnik praktično **ne vodi budžet ručno**, nego samo „priča“ sa aplikacijom:

> „Čaka prodavnica 700“  
> „Lidl 2.000“  
> „Dejan rođa 3.600“  
> „Plata 145.000“  
> „Danas sam potrošio 1.200 na gorivo“

AI u pozadini razume unos, strukturira ga, kategorizuje i vodi finansijsku sliku.

### Kako bih ja zamislio proizvod

image_group{"layout":"carousel","aspect_ratio":"16:9","query":["modern personal finance dashboard mobile app UI","personal budget app dashboard dark mode","AI finance assistant mobile UI","personal finance analytics dashboard web app"]}

## 1. Glavna ideja: „upiši kako bi rekao čoveku“

Umesto forme:

- Iznos
- Kategorija
- Prodavnica
- Datum
- Tip troška
- Napomena

korisnik samo napiše:

**„Lidl 2.000“**

AI napravi:

```text
Iznos:       2.000 RSD
Tip:         Trošak
Kategorija:  Hrana
Merchant:    Lidl
Datum:       10.09.2026.
```

I eventualno:

> „Pretpostavio sam da je Lidl → Hrana. Ispravi ako nije.“

---

### Još zanimljiviji primer

**„Dejan rođa 3600“**

AI može da prepozna:

```text
3.600 RSD
Kategorija: Pokloni / Porodica
Opis: Dejan - rođendan
```

Ako nema dovoljno konteksta:

> „Da li je 3.600 RSD poklon Dejanu?“

Jednom kada korisnik potvrdi, sistem može da nauči:

```text
Dejan → Pokloni
```

Sledeći put:

**„Dejan 2000“**

→ automatski kategorizuje kao **Pokloni**.

---

# 2. AI ne treba da bude samo chatbot

Ovo je najvažniji deo.

Ne bih pravio:

> „ChatGPT unutar aplikacije za budžet.“

Napravio bih **AI financial engine** koji stalno analizira podatke.

Na primer:

### Korisnik ima

```text
Mesečni prihod: 160.000 RSD

Hrana:          30.000
Gorivo:         15.000
Računi:         25.000
Pretplate:       8.000
Deca:            20.000
Ostalo:          15.000
```

AI može da kaže:

> ⚠️ Trošiš 23% više na hranu nego prethodnog meseca.

ili:

> 🎯 Ako nastaviš ovim tempom, do kraja meseca ćeš potrošiti oko 171.500 RSD.

ili:

> 💰 Da bi ostvario cilj štednje od 30.000 RSD, ovog meseca ti je preostalo 8.700 RSD za neplanirane troškove.

To je već **pametan sistem**, a ne expense tracker.

---

# 3. Budžet kao „živi sistem“

Korisnik može da kaže:

> **„Hoću da uštedim 300.000 dinara do juna.“**

A aplikacija napravi:

```text
🎯 Cilj
300.000 RSD

Rok
30.06.2027.

Potrebno mesečno
≈ 31.600 RSD
```

I onda svaki mesec prati:

```text
JAN     ██████████  32.000 ✓
FEB     █████████   29.000
MAR     ███████████ 35.000 ✓
APR     ...
```

Ali AI ide korak dalje.

Ako korisnik potroši mnogo više nego obično:

> ⚠️ Ovaj mesec si trenutno 6.400 RSD iznad plana.  
> Ako želiš da zadržiš cilj štednje, predlažem da naredne dve nedelje ograničiš „Ostalo“ na oko 3.000 RSD.

---

# 4. AI može da predviđa kraj meseca

Ovo bi bila jedna od glavnih funkcija.

Recimo 10. je u mesecu.

Aplikacija vidi:

```text
Potrošeno: 48.000
Dani: 10 / 30
```

I izračuna:

```text
Trenutni tempo:
4.800 RSD / dan

Predviđanje:
≈ 144.000 RSD
```

Ako je plan:

```text
120.000 RSD
```

dobijaš:

> 🔴 Trenutnim tempom premašićeš mesečni budžet za oko 24.000 RSD.

---

# 5. „Koliko smem danas da potrošim?“

Ovo bih stavio kao jednu od centralnih funkcija.

Na dashboardu:

## Danas

### 🟢 Možeš da potrošiš

**2.350 RSD**

bez ugrožavanja cilja štednje.

A ispod:

```text
Mesečni budžet       120.000
Potrošeno              68.450
Rezervisano            12.000
Cilj štednje           25.000
--------------------------------
Preostaje               14.550
```

AI iz toga izračuna koliko je bezbedno trošiti.

---

# 6. Alert sistem

Ne samo klasične notifikacije.

### Budžet

> 🔔 Hrana je dostigla 80% mesečnog budžeta.

### Predikcija

> ⚠️ Ako nastaviš ovim tempom, premašićeš budžet za ~7.200 RSD.

### Pretplate

> 💳 Sutra se očekuje naplata Netflixa 1.299 RSD.

### Neuobičajena potrošnja

> 👀 Ovaj mesec si već potrošio 18.000 RSD na restorane — 60% više nego prosečno.

### Štednja

> 🎯 Još 4.500 RSD i ovog meseca si ostvario cilj štednje.

### Pozitivan feedback

Ovo je bitno.

Ne samo:

❌ „Previše trošiš.“

nego:

> 🎉 Odličan mesec!  
> Potrošio si 8.200 RSD manje nego prošlog meseca.

---

# 7. AI Assistant

Može postojati jedan ekran:

## 🤖 Moj finansijski asistent

Korisnik pita:

> Koliko sam potrošio na hranu ovog meseca?

AI:

> Do sada si potrošio **27.450 RSD** na hranu. To je 3.200 RSD više nego u istom periodu prošlog meseca.

---

Korisnik:

> Gde mi odlazi najviše para?

AI:

```text
1. 🏠 Stan + računi       31%
2. 🍔 Hrana               22%
3. 🚗 Auto                14%
4. 👨‍👩‍👧 Porodica           11%
5. 💳 Pretplate             7%
```

---

Korisnik:

> Kako da uštedim 20.000 ovog meseca?

AI analizira istoriju i predlaže:

```text
🍔 Hrana       -7.000
🚗 Gorivo      -3.000
🛒 Ostalo      -5.000
💳 Pretplate   -2.000
────────────────────
                  17.000

Preostalo:       3.000
```

---

# 8. Posebno bih napravio „Memory“

Ovo bi bilo jako zanimljivo.

Sistem vremenom zna:

```text
Lidl → Hrana
Maxi → Hrana
Shell → Gorivo
OMV → Gorivo
Dejan → Poklon
EPS → Struja
Telekom → Telefon
```

Ali i:

```text
Plata → Prihod
Kirija → Stanovanje
```

AI može da uči iz korekcija.

Ako korisnik kaže:

> „Ne, Dejan nije poklon. To je pozajmica.“

sistem zapamti.

Sledeći put:

> „Dejan 5000“

→

**Pozajmica → Dejan → 5.000 RSD**

---

# 9. Poseban koncept: „Rules“

Pored AI-a, napravio bih deterministički rule engine.

Na primer:

```text
IF merchant = "Lidl"
THEN category = "Food"
```

AI služi za razumevanje **nejasnog inputa**, dok rules engine garantuje konzistentnost.

To je mnogo bolja arhitektura nego da svaki put pitaš LLM:

```text
"Lidl 2000"
```

LLM → odgovor

nego:

```text
User input
    ↓
Parser
    ↓
AI classification
    ↓
Rules
    ↓
Transaction
    ↓
Budget Engine
    ↓
Alert Engine
    ↓
Analytics
```

---

# 10. UX bih napravio ekstremno jednostavan

Desktop:

```text
┌───────────────────────────────────────────────────────┐
│  🏠 Moj Budžet                         🔔  👤          │
├────────────┬──────────────────────────────────────────┤
│            │                                          │
│ Dashboard  │     Dobro veče 👋                       │
│            │                                          │
│ Transakcije│     Ovaj mesec                          │
│            │     87.450 RSD                           │
│ Budžeti    │     ─────────────────                    │
│            │     Budžet: 120.000                     │
│ Ciljevi    │     Preostalo: 32.550                   │
│            │                                          │
│ Analitika  │     🎯 Štednja                          │
│            │     21.000 / 30.000                     │
│ AI         │                                          │
│            │     ⚠️ Hrana je na 82% budžeta          │
│ Settings   │                                          │
│            │                                          │
└────────────┴──────────────────────────────────────────┘

          ┌─────────────────────────────────┐
          │ 💬 Šta si danas potrošio?       │
          │                                 │
          │ Lidl 2000                      │
          │                                 │
          │                         ➤       │
          └─────────────────────────────────┘
```

Na telefonu bih čak išao još jednostavnije:

```text
        Moj Budžet

     32.550 RSD
    preostalo ovaj mesec

 ─────────────────────

 🎯 Štednja
 21.000 / 30.000

 ⚠️ Hrana
 82% budžeta

 ─────────────────────

       + Unesi trošak

 ─────────────────────

 Danas

 Lidl              -2.000
 Gorivo            -3.500
 Dejan             -3.600
```

A **floating input** bi praktično bio srce aplikacije.

---

# 11. Još jedna killer funkcija

### Fotografisanje računa

Korisnik slika račun iz Lidla.

AI/OCR:

```text
Lidl
10.09.2026.

Hleb             89
Mleko           179
Meso            899
Voće            430
Ostalo          403
──────────────────
TOTAL          2.000
```

I aplikacija može čak da kategorizuje pojedinačne stavke.

To kasnije omogućava:

> „Koliko sam ovog meseca dao na meso?“

To je već ozbiljan proizvod.

---

# 12. Tehnologija

Pošto već radiš **Angular + NestJS/Go + GraphQL + Docker**, ja bih ovaj projekat napravio tako da bude i odličan **AI engineering projekat**.

Moj predlog:

### Frontend

**Angular**

- Angular 21+
- Signals
- PWA
- Responsive
- Desktop/mobile
- Charts
- Offline-first input

### Backend

**NestJS + GraphQL**

ili, ako želiš da eksperimentišeš sa Go:

**Go + gqlgen**

### Database

**PostgreSQL**

Za finansijske podatke bih pre izabrao PostgreSQL nego MongoDB.

### Cache / jobs

**Redis**

### AI

Napraviti abstraction:

```typescript
interface AIProvider {
  parseTransaction(input: string): Promise<TransactionIntent>;
  categorizeTransaction(transaction: Transaction): Promise<Category>;
  analyzeBudget(context: BudgetContext): Promise<Insight[]>;
}
```

Pa možeš imati:

```text
OpenAI
Anthropic
Gemini
DeepSeek
Local model
```

bez menjanja ostatka sistema.

---

# 13. Ali najvažnije: AI ne sme da odlučuje o novcu bez kontrole

Za finansijsku aplikaciju bih strogo razdvojio:

### AI

Može:

- interpretirati tekst
- predložiti kategoriju
- generisati insight
- predložiti budžet
- objasniti potrošnju

### Deterministički backend

Mora da odlučuje:

- stanje računa
- zbir transakcija
- budžetske limite
- štednju
- matematičke kalkulacije
- recurring transactions

Drugim rečima:

**LLM nikada ne treba da bude source of truth.**

---

# 14. Monetizacija

Ako bi ovo jednog dana bio SaaS:

### Free

- ručni unos
- osnovni budžet
- 3 cilja
- osnovna analitika

### Pro — npr. 399–599 RSD / mesečno

- AI unos
- AI kategorisanje
- AI Assistant
- neograničeni ciljevi
- napredne analize
- predikcije
- smart alerts
- OCR računa

### Family — npr. 799–999 RSD

Ovo mi je posebno zanimljivo za Srbiju:

```text
Porodica

👨 Goran
👩 Partner
👦 Dete
👧 Dete
```

Zajednički budžet + individualni troškovi.

---

# 15. Ime proizvoda

Ako ciljaš Srbiju/Balkan, mogao bi da imaš veoma jednostavan brand:

**BudžetAI**

ili nešto modernije:

- **PametniBudžet**
- **MojBudžet**
- **FinAI**
- **Kasa**
- **Novčanik**
- **Pametni Novčanik**
- **Finora**
- **Budgely**
- **Finio**
- **Moneta**
- **Spendly**

Ali bih ime birao tek nakon provere domena, trademark-a i postojećih proizvoda.

---

## 🚀 Ja bih ovo zapravo napravio kao pravi proizvod

I što je još zanimljivije, **odlično se uklapa u tvoj dosadašnji pravac rada sa AI engineeringom**: Angular frontend, GraphQL backend, multi-tenant arhitektura, AI abstraction, background jobs, Redis, notifications, PWA itd.

MVP ne bih pravio kao ogroman sistem.

### V1 — 30 dana

**Week 1**

- Auth
- dashboard
- transactions
- categories
- income/expense
- monthly budget

**Week 2**

- natural language input
- AI parser
- automatic categorization
- merchant memory
- recurring transactions

**Week 3**

- saving goals
- budget alerts
- spending predictions
- analytics
- notifications

**Week 4**

- AI Assistant
- mobile PWA
- polished UI
- onboarding
- production deployment

A onda V2:

**OCR računa + Family Budget + bank integrations + AI financial coach.**

---

### Jedna stvar koju bih posebno promenio u odnosu na klasične budget aplikacije

Ne bih korisniku na prvom ekranu dao:

> **„Dodaj transakciju“**

nego:

> ### 💬 Šta se danas dešavalo sa novcem?

i jedno ogromno polje:

**„Lidl 2000, gorivo 3500, plata 150000“**

Može čak **više transakcija jednim unosom**.

AI odgovori:

> Dodao sam 3 transakcije:
>
> 🛒 Lidl — 2.000 RSD — Hrana  
> ⛽ Gorivo — 3.500 RSD — Auto  
> 💰 Plata — 150.000 RSD — Prihod
>
> **Ovog meseca si sada na 68.450 RSD potrošnje i 150.000 RSD prihoda.**

To je UX koji bi mogao da napravi razliku između **„još jedne budget aplikacije“** i proizvoda koji ljudi stvarno žele da koriste.

## [7] User

Odlično sve si lepo predvideo s tim sto  moramo kategorizacija lepo da smislimo osim kad slikam račun lidl ne mora ds bude samo hrana a dejan rođa znači rođak i za njega znam crpe septičku jamu treba da imamo mogučnost da definišemo ključne reči za  kategorije zatim mogućnost i ručnog dodavanja stavki kategorija i ostalog dakle primarno Ai a i mogućnost ručnog dodavanja menjanja i brusanha


## [9] Assistant

Da — **to je zapravo ključna stvar arhitekture**. AI treba da bude primarni način unosa i kategorizacije, ali korisnik mora u svakom trenutku da ima **potpunu kontrolu i mogućnost korekcije**.

Posebno je dobar tvoj primer:

> **„Dejan rođa 3600“**

AI ne sme da zaključi samo:

`Dejan → Poklon`

jer korisnik možda zna da je Dejan **rođak koji mu je čistio septičku jamu**.

Zato bih napravio **hibridni sistem: AI + Rules + User data + Manual override**.

## 1. Hijerarhija odlučivanja

Kategorizacija bi mogla da radi ovim redom:

```text
                    ┌──────────────────┐
                    │  "Dejan rođa 3600"│
                    └────────┬─────────┘
                             ↓
                    ┌──────────────────┐
                    │ Normalizacija    │
                    │ teksta / iznosa  │
                    └────────┬─────────┘
                             ↓
              ┌────────────────────────────┐
              │ Korisnička pravila /       │
              │ ključne reči                │
              └─────────────┬──────────────┘
                            ↓
                     pronađeno pravilo?
                       /            \
                     DA              NE
                     ↓                ↓
                Kategorija          AI
                                      ↓
                                Predlog kategorije
                                      ↓
                              korisnik potvrđuje
                                      ↓
                              učenje / pravilo
```

Dakle, **AI nije gazda sistema**. 😄

AI je inteligentni sloj iznad strukturiranih podataka.

---

# 2. Kategorije treba da budu potpuno korisnički definisane

Na primer:

```text
Troškovi
│
├── Hrana
│   ├── Supermarket
│   ├── Pekara
│   └── Restoran
│
├── Automobil
│   ├── Gorivo
│   ├── Servis
│   ├── Delovi
│   └── Registracija
│
├── Kuća
│   ├── Struja
│   ├── Voda
│   ├── Grejanje
│   └── Septička jama
│
├── Porodica
│   ├── Deca
│   ├── Pokloni
│   └── Ostalo
│
└── Zabava
```

Ali korisnik može da napravi potpuno svoju strukturu.

Recimo:

**Kuća → Održavanje → Septička jama**

---

# 3. Ključne reči su veoma bitne

Svaka kategorija može imati:

### Kategorija

**Kuća → Septička jama**

### Ključne reči

```text
septička
septicka
septičke
septicke
jama
pražnjenje jame
čišćenje jame
cisterna
```

A može imati i **isključujuće ključne reči**.

Na primer:

**Auto → Gorivo**

```text
gorivo
benzin
dizel
nafta
```

ali:

```text
ulje
filter
servis
```

ne treba da ode u gorivo.

---

# 4. Ali ključna reč nije dovoljna

Ovo je još jedan važan detalj.

Korisnik napiše:

> „Lidl 2000“

AI može da zna:

**Merchant = Lidl**

ali ne sme automatski:

> Lidl = Hrana

zauvek.

Jer račun iz Lidla može da sadrži:

```text
Hleb             100
Mleko            150
Hrana           1000
Sredstvo za sudove 300
Šampon           450
```

Zato bih imao **dva nivoa kategorizacije**.

### Transaction level

```text
Lidl
2.000 RSD
Hrana
```

jednostavan unos.

### Receipt level

Ako korisnik slika račun:

```text
Lidl
──────────────────
Meso             800 → Hrana
Mleko            200 → Hrana
Šampon           500 → Higijena
Deterdžent       300 → Kuća
Voće             200 → Hrana
──────────────────
TOTAL           2000
```

**AI kategorizuje stavke, ne prodavnicu.**

To je mnogo kvalitetniji sistem.

---

# 5. „Dejan“ je zapravo Entity / Contact

Ovo bih čak modelovao posebno.

Umesto:

```text
Dejan → category
```

imali bismo:

```text
Person / Entity

Dejan
```

i korisnik može da definiše:

```text
Naziv: Dejan
Tip: Osoba

Ključne reči:
dejan
dejan rođa
rođa dejan

Podrazumevana kategorija:
Kuća → Septička jama
```

Onda:

> **„Dejan rođa 3600“**

AI izvuče:

```text
Entity: Dejan
Amount: 3600
Description: rođa
```

Rules engine pronađe:

```text
Dejan → Kuća → Septička jama
```

Rezultat:

> 🏠 Septička jama — 3.600 RSD

---

# 6. Korisnik mora moći da promeni SVE

Svaka transakcija:

```text
┌───────────────────────────────┐
│ Dejan rođa                    │
│ -3.600 RSD                    │
│                               │
│ Kategorija                    │
│ 🏠 Kuća / Septička jama       │
│                               │
│ 👤 Dejan                      │
│                               │
│ 📅 10.09.2026                 │
│                               │
│ Napomena                      │
│ Čišćenje septičke jame        │
│                               │
│ [ Izmeni ] [ Obriši ]         │
└───────────────────────────────┘
```

Korisnik može da promeni:

- iznos
- datum
- kategoriju
- podkategoriju
- osobu
- merchant
- opis
- napomenu
- način plaćanja
- račun
- tagove
- recurring status

---

# 7. I posebno: „Zapamti ovo pravilo“

Ovo će biti **fantastičan UX**.

Korisnik unese:

> Dejan 3600

AI:

> Predlažem: **Kuća → Septička jama**

Korisnik promeni:

> **Kuća → Održavanje**

i pojavi se:

**☑ Zapamti za ubuduće**

Ako klikne:

```text
Dejan
↓
Kuća → Održavanje
```

Sledeći put AI praktično ni ne mora da razmišlja.

---

# 8. Ručno dodavanje kategorija

Settings:

```text
Kategorije

Troškovi
 ├─ Hrana
 ├─ Automobil
 ├─ Kuća
 │   ├─ Struja
 │   ├─ Voda
 │   └─ Septička jama
 └─ Porodica

             + Dodaj kategoriju
```

Forma:

```text
Naziv
[ Septička jama              ]

Parent
[ Kuća                       ]

Ikonica
[ 🏠 ]

Boja
[ ... ]

Ključne reči
[ septička, septicka, jama ]

AI instrukcija
[ Troškovi čišćenja i pražnjenja
  septičke jame ]

[ Sačuvaj ]
```

Ovo poslednje je zanimljivo jer možemo dozvoliti korisniku da doda **AI description** kategorije.

---

# 9. Tags treba odvojiti od kategorija

Ovo bih obavezno napravio.

Kategorija:

> **Kuća → Septička jama**

Tagovi:

```text
#održavanje
#dejan
#vanredni-trošak
```

Jer jedna transakcija može imati:

```text
Category:
Kuća / Održavanje

Tags:
Dejan
Vanredno
```

To će kasnije mnogo pomoći AI analizi.

---

# 10. Merchant management

Isto treba da postoji:

```text
Merchants

Lidl
Maxi
Idea
DIS
Shell
OMV
```

Klikneš:

**Lidl**

```text
Naziv: Lidl

AI hints:
supermarket

Default category:
Hrana

Keywords:
lidl
lidl srbija

Aliases:
lidl prodavnica
```

Ali:

**Default category nije obavezna.**

Ako postoji receipt OCR, stavke imaju prednost.

---

# 11. AI treba da vraća confidence

Ovo bih ugradio od prvog dana.

Na primer:

```text
Lidl 2000

Category:
Hrana

Confidence:
96%
```

Ali:

```text
Dejan 3600

Category:
Kuća / Održavanje

Confidence:
61%

⚠️ Nisam siguran šta je ovaj trošak.
```

UI može da prikaže:

🟢 **96% — sigurno**

🟡 **61% — proveri**

🔴 **34% — potrebna potvrda**

Tako korisnik ne mora da potvrđuje ono što je očigledno.

---

# 12. I onda dobijaš pravi AI feedback loop

Recimo:

```text
User
 ↓
"Lidl 2000"
 ↓
AI
 ↓
Hrana 96%
 ↓
Transaction
```

Korisnik kaže:

> Nije hrana, kupio sam deterdžent.

Sistem:

```text
Transaction correction
        ↓
User preference
        ↓
Learning signal
        ↓
Future classification
```

Ali **ne bih dozvolio da LLM sam menja pravila**. Backend treba da odluči kada je korekcija dovoljno jasna da napravi rule.

---

# 13. Arhitektura koju bih sada postavio

Ovako bih definisao domain:

```text
User
 │
 ├── Categories
 │     ├── Keywords
 │     └── Rules
 │
 ├── Merchants
 │
 ├── Entities
 │     └── People / Companies
 │
 ├── Tags
 │
 ├── Transactions
 │
 ├── Receipts
 │     └── ReceiptItems
 │
 ├── Budgets
 │
 ├── SavingGoals
 │
 └── AI Preferences
```

A obrada:

```text
             User Input
                 │
                 ▼
          Natural Language
              Parser
                 │
                 ▼
        ┌─────────────────┐
        │ Entity Resolver │
        └────────┬────────┘
                 │
        ┌────────▼────────┐
        │ Rules Engine    │
        └────────┬────────┘
                 │
          Rule found?
          /          \
        YES           NO
         │             │
         │            AI
         │             │
         │       classification
         │             │
         └──────┬──────┘
                ▼
          Transaction
                │
                ▼
          Budget Engine
                │
                ▼
         Alert / Insights
```

## I još jedna važna stvar

Ja bih **od početka napravio AI provider abstraction**, jer ti omogućava da eksperimentišeš sa različitim modelima:

```text
AI Provider
├── OpenAI
├── Anthropic
├── Gemini
├── DeepSeek
└── Local
```

Za jednostavan parsing:

> `Lidl 2000`

ne moraš trošiti skup model.

Za kompleksnu analizu:

> „Zašto sam ovog meseca potrošio više nego prethodna tri meseca i šta mogu da promenim a da ne smanjim kvalitet života?“

možeš koristiti jači model.

---

**Po meni smo sada već definisali dovoljno dobar koncept da sledeći korak ne treba da bude još ideja, nego konkretan dizajn sistema.**

Mogu da ti napravim sledeće **„Home Budget AI — Product & Technical Specification v1“**: kompletan model baze (PostgreSQL), GraphQL schema, AI pipeline, category/rule engine, strukturu Angular aplikacije, ekrane, user flow, notification engine i **tačno definisan MVP koji možemo krenuti da kodiramo uz Claude Code/Opencode**.

## [10] User

kako bi nazvali projekat?

## [15] Assistant

Za ovaj projekat bih izbegao ime koje direktno zvuči kao „expense tracker“. Poenta proizvoda je **pametan kućni finansijski asistent**, a ne samo evidencija troškova.

Moji favoriti:

### 🥇 **Finora**
Zvuči kao pravi SaaS proizvod, kratko je i internacionalno.

> **Finora — Your AI Household Finance Assistant**

Dobro funkcioniše i ako kasnije izađemo van Srbije.

### 🥈 **BudžetAI**
Odmah je jasno šta proizvod radi.

> **BudžetAI — Pametniji način upravljanja novcem**

Odlično za srpsko tržište, ali je manje pogodno ako kasnije želiš internacionalizaciju.

### 🥉 **Novčić**
Prijatno, lako pamtljivo i lokalno.

> **Novčić — Tvoj pametni kućni budžet**

Ima simpatičan karakter, mada je manje „premium“.

### Još nekoliko koje bih razmotrio

| Ime | Utisak | Internacionalno |
|---|---|---|
| **Finora** | 🚀 SaaS / ozbiljno | ⭐⭐⭐⭐⭐ |
| **Finio** | moderno / jednostavno | ⭐⭐⭐⭐⭐ |
| **Budgely** | startup / AI | ⭐⭐⭐⭐⭐ |
| **Monevo** | finance / moderno | ⭐⭐⭐⭐⭐ |
| **PametniBudžet** | jasno / domaće | ⭐⭐⭐ |
| **MojBudžet** | jednostavno | ⭐⭐⭐ |
| **Novčić** | simpatično / domaće | ⭐⭐ |
| **Kasa** | veoma kratko | ⭐⭐⭐ |
| **FinMate** | finansijski pomoćnik | ⭐⭐⭐⭐⭐ |
| **HomeFin** | kućne finansije | ⭐⭐⭐⭐ |

### Ali meni je posebno zanimljiv koncept **FinMate**

Jer proizvod zapravo postaje:

> **FinMate**  
> *Your AI financial companion.*

Ne govoriš korisniku:

> „Evidentiraj trošak.“

Nego:

> „FinMate, koliko još mogu da potrošim ovog meseca?“

> „FinMate, gde mi odlazi novac?“

> „FinMate, napravi plan da uštedim 300.000 RSD.“

To mnogo bolje opisuje ono što gradimo.

---

**Moj trenutni ranking:**

1. 🥇 **Finora** — ako želimo ozbiljan globalni proizvod
2. 🥈 **FinMate** — ako želimo naglasiti AI asistenta
3. 🥉 **Finio** — ako želimo kratko, moderno ime
4. **BudžetAI** — ako prvo ciljamo Srbiju
5. **Novčić** — ako želimo prijateljski domaći brend

Pre nego što se odlučimo, ja bih ipak **proverio dostupnost domena, GitHub organizacije/repozitorijuma, npm paketa i postojeće proizvode/trademarks**, jer lepo ime ne vredi mnogo ako je već zauzeto.

Ako želiš, mogu da uradim **web pretragu 20–30 potencijalnih imena i izdvojim 5 najboljih koja imaju najmanje problema sa postojećim brendovima i domenima**.

## [16] User

engleski naziv

## [17] assistant → web.run

_(web search call, no visible text)_

## [18] tool (web.run)

_(output redacted by ChatGPT)_

## [19] tool (web.run)

_(output redacted by ChatGPT)_

## [22] Assistant

Da. Ako idemo na **engleski naziv i potencijalno globalni proizvod**, onda bih potpuno promenio kriterijum: kratko, lako za izgovor, da ne bude previše vezano za „budget“, i da može da postane **brand**, a ne samo naziv aplikacije.

Usput, nakon provere, **Finora, Finio, FinMate i Monevo bih izbacio** — već postoje finansijske aplikacije/proizvodi sa tim imenima. citeturn0search0turn0search2turn0search5turn0search6

### Moji favoriti

**1. Spendora** ⭐⭐⭐⭐⭐  
`spend + aura`  
Zvuči kao ozbiljan consumer fintech proizvod.

> **Spendora**  
> *Know your money. Live smarter.*

**2. Monevia** ⭐⭐⭐⭐⭐  
`money + via` — „put novca“.  
Lepo zvuči i za AI finansijskog asistenta.

> **Monevia**  
> *Your money, made smarter.*

**3. Spendwise** ⭐⭐⭐⭐  
Odmah komunicira svrhu:

> **Spendwise**  
> *Spend smarter. Save more.*

Mana: manje je unikatan kao brand.

**4. Monexa** ⭐⭐⭐⭐⭐  
Kratko, moderno, fintech osećaj.

> **Monexa**  
> *Your intelligent money companion.*

**5. Savora** ⭐⭐⭐⭐⭐  
Od `save` + elegantan suffix. Dobar ako želimo da glavna priča bude **uštedeti više**, a ne samo pratiti troškove.

> **Savora**  
> *Turn spending into savings.*

**6. Budgora** ⭐⭐⭐⭐  
`budget + ...`  
Direktnije vezano za budžet, ali meni je manje elegantno od Spendora/Savora.

**7. Cashly** ⭐⭐⭐⭐  
Vrlo jednostavno i friendly.

> **Cashly**  
> *Your money. Your plan.*

**8. Monevo** — zvuči odlično, **ali već postoji** finance/budget app, pa ga ne bih koristio. citeturn0search6

---

## A meni se zapravo najviše sviđa jedan drugi pravac

Pošto naša aplikacija nije samo:

> expense tracker

nego:

> **AI koji razume kako domaćinstvo koristi novac i pomaže mu da donosi bolje odluke**

mogli bismo da idemo na ime koje **uopšte ne sadrži money/budget/spend**.

Na primer:

### **Nomi**
Kratko, friendly, lako pamtljivo.

> **Nomi**  
> *Your AI money companion.*

### **Milo**
Veoma friendly consumer brand.

> **Milo**  
> *Make every dinar count.*

### **Penny**
Ali je previše generičko i verovatno zauzeto.

### **Numa**
Lepo zvuči za AI/finance proizvod.

> **Numa**  
> *Understand your money.*

---

### Moj trenutni TOP 5

| | Naziv | Brand | AI osećaj | Globalno |
|---|---|---:|---:|---:|
| 🥇 | **Spendora** | 9.5 | 8 | 9.5 |
| 🥈 | **Savora** | 9.5 | 8 | 9.5 |
| 🥉 | **Monexa** | 9 | 9 | 9 |
| 4 | **Monevia** | 9 | 8 | 9 |
| 5 | **Numa** | 9.5 | 9 | 9.5 |

**Ja bih lično trenutno izabrao `Spendora`.**

I mogao bi da ima baš lep positioning:

> # Spendora
> **Your AI household money companion.**
>
> Just tell Spendora what happened with your money.  
> It understands, categorizes, learns your habits, watches your budget and helps you save.

To već zvuči kao **pravi startup**, a ne kao projekat za evidenciju troškova.

Pre nego što zaključamo ime, sledeći korak bih napravio još ozbiljnije: **30 potpuno novih imena + provera Google/App Store/GitHub/domena i osnovnog trademark konflikta**, pa da izaberemo ime koje zaista možemo da gradimo kao brand.
