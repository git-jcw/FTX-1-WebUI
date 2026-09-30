# FTX-1 CAT notes

Working notes on the Yaesu FTX-1 CAT protocol as used by FTX Deck.

Sources: Yaesu *FTX-1 Series CAT Operation Reference Manual* (2508-C) and the
open-source Hamlib FTX-1 backend (model 1051), which is hardware-tested against
November 2025 firmware. Anything marked **verify** hasn't been checked on a real
radio by this project yet.

## Link

- USB gives two virtual COM ports (Silicon Labs CP210x):
  - **Enhanced COM** (CAT-1) — use this for CAT.
  - **Standard COM** (CAT-2) — PTT/keying; RTS/DTR on it can key the radio.
- Default 38400 baud, 8N1, no flow control. Radio menu can set 4800–115200.
- Every command and reply ends with `;`. A bad or unsupported command answers `?;`.
- `ID;` → `ID0840;` for every FTX-1 configuration (Field head or Optima/SPA-1).

## MAIN / SUB

Most receive-side commands take a first digit P1: `0` = MAIN, `1` = SUB.
FTX Deck calls MAIN "VFO A" and SUB "VFO B" in the UI.

| Purpose | Read | Set | Notes |
|---|---|---|---|
| MAIN freq | `FA;` → `FA014250000;` | `FA014250000;` | 9 digits, Hz |
| SUB freq | `FB;` | `FB007074000;` | |
| Mode | `MD0;` → `MD02;` | `MD02;` | P1 VFO, P2 mode code (below) |
| VFO select | `VS;` → `VS0;` | `VS1;` | 0 MAIN, 1 SUB |
| TX VFO (split) | `FT;` → `FT0;` | `FT1;` | Split = RX MAIN, TX SUB. `ST` not used |
| Dual/single RX | `FR;` → `FR00;` | `FR01;` | 00 dual, 01 single |
| A→B / B→A / swap | | `AB;` `BA;` `SV;` | |
| Band up/down | | `BU0;` `BD0;` | `BS` (band select) answers `?` on current firmware — tune with `FA` instead |

### Mode codes (MD P2)

`1` LSB · `2` USB · `3` CW-U · `4` FM · `5` AM · `6` RTTY-L · `7` CW-L ·
`8` DATA-L · `9` RTTY-U · `A` DATA-FM · `B` FM-N · `C` DATA-U · `D` AM-N ·
`E` PSK · `F` DATA-FM-N · `H` C4FM-DN · `I` C4FM-VW

## Receive DSP

| Purpose | Format | Range |
|---|---|---|
| AF gain | `AG0nnn;` | 000–255 |
| RF gain | `RG0nnn;` | 000–255 |
| Squelch | `SQ0nnn;` | 000–100 |
| AGC | `GT0n;` | set 0 OFF, 1 FAST, 2 MID, 3 SLOW, 4 AUTO. Reads can return 4–6 for AUTO resolving to fast/mid/slow |
| Preamp | `PA0n;` (HF/50) | 0 IPO, 1 AMP1, 2 AMP2. `PA1n;`/`PA2n;` for 144/430, 0/1 |
| Attenuator | `RA0n;` | 0 off, 1 on (12 dB) |
| Width | `SH00nn;` | code 00–23 (00 = default), table below |
| IF shift | `IS00` + sign + `nnnn` e.g. `IS00+0200;` | ±1200 Hz, 20 Hz steps. P2 is fixed at `0` (Yaesu's manual; its own example is `IS00+1000;`). Hamlib sends P2 = `1` for "shift on", which the radio didn't act on |
| Noise blanker | `NL0nnn;` | 000 = off, 001–010 |
| DNR | `RL0nn;` | 00 = off, 01–10 |
| DNF (auto notch) | `BC0n;` | 0/1 |
| Manual notch on/off | `BP00nnn;` | 000 off, 001 on |
| Manual notch freq | `BP01nnn;` | 001–320 × 10 Hz |
| Contour on/off | `CO00nnnn;` | 0000/0001 |
| Contour freq | `CO01nnnn;` | 0010–3200 Hz |
| APF on/off | `CO02nnnn;` | CW only |
| Narrow | `NA0n;` | 0/1 |
| Squelch type | `CT0n;` | 0 OFF, 1 ENC, 2 TSQ, 3 DCS, 4 PR FREQ, 5 REV TONE. The IF/OI answer lists ENC and TSQ the other way round; **verify** |
| CTCSS tone | `CN00nnn;` | 000–049, 67.0–254.1 Hz (standard 50-tone table) |
| DCS code | `CN01nnn;` | 000–103, codes 023–754 |

Squelch state: `RI0;` → `RI` + eight digits P1–P8, P8 `1` = squelch open (BUSY),
`0` = closed. Seen on hardware on 2 m FM with MAIN selected: `RI00000000;`
squelched, `RI00000001;` with the squelch opened. `RI1;` gets no answer.

The USB receive audio is not muted by the radio's squelch. FTX Deck tried
silencing the PC speakers from P8, but on 20 m USB it stayed muted with a
signal plainly present, so P8 isn't a usable "audio is present" signal outside
FM. FTX Deck no longer uses `RI`; the PC always plays the USB audio.

The `NB0x`/`NR0x` on/off commands used on other Yaesu rigs answer `?;` on the FTX-1;
on/off is done with the level commands above.

### Width codes (SH)

- SSB: 01=300 02=400 03=600 04=850 05=1100 06=1200 07=1500 08=1650 09=1800
  10=1950 11=2100 12=2250 13=2400 14=2450 15=2500 16=2600 17=2700 18=2800
  19=2900 20=3000 21=3200 22=3500 23=4000 Hz
- CW / DATA / RTTY / PSK: 01=50 02=100 03=150 04=200 05=250 06=300 07=350
  08=400 09=450 10=500 11=600 12=800 13=1200 14=1400 15=1700 16=2000
  17=2400 18=3000 19=3200 20=3500 21=4000 Hz
- AM / FM widths are fixed.

## Transmit

| Purpose | Format | Notes |
|---|---|---|
| PTT | `TX0;` off, `TX1;` on (CAT), `TX2;` on (DATA/rear audio) | `TX;` reads state |
| Power | `PC;` → `PC2050;` | P1 `2` = Optima/SPA-1 (005–100 W, whole watts). P1 `1` = Field head: `PC1005;` whole watts or `PC10.5;` fractional, 0.5–6 W battery / 0.5–10 W on 12 V |
| Mic gain | `MGnnn;` | 000–100 |
| Processor | `PR0n;` | 0/1 |
| Processor level | `PLnnn;` | 000–100 |
| AMC | `AOnnn;` | 000–100 |
| VOX | `VXn;` | 0/1 |
| VOX gain | `VGnnn;` | 000–100 |
| Monitor level | `ML0nnn;` | 000–100 |
| Tuner | `AC` P1 P2 P3, see below. `AC;` → P3 ≠ 0 while tuning | Internal tuner needs Optima/SPA-1 |
| Key speed | `KSnnn;` | 004–060 wpm |
| Key pitch | `KPnn;` | 00–75 → 300–1050 Hz in 10 Hz steps |

### Antenna tuner (AC)

`AC` P1 P2 P3: P1 `0` internal / `1` external port, P2 `0` tuner / `2` ATAS,
P3 `0` stop, `3` start (ATAS also `1` up, `2` down).

The tuner in use is whatever the radio menu has selected; TUNE only starts a
cycle on it. FTX Deck reads the selection first:

- `EX030704;` → HF antenna in use, `0` ANT1, `1` ANT2.
- `EX030701;` / `EX030702;` → TUNER TYPE SEL for ANT1 / ANT2:
  `0` INT, `1` INT (FAST), `2` EXT, `3` ATAS.

It then sends the start forms in this order until one isn't answered `?;`:

| Tuner type | Start | Stop |
|---|---|---|
| INT, INT (FAST) | `AC003;` then `AC103;` | `AC000;` then `AC100;` |
| EXT | `AC103;` then `AC003;` | `AC000;` then `AC100;` |
| ATAS | `AC123;` | `AC120;` |
| menu unreadable | `AC103;`, `AC003;`, `AC123;` | `AC000;`, `AC100;`, `AC120;` |

`AC;` can't be used on its own to tell when a tune has finished: on a real radio
the app went on seeing P3 ≠ 0 long after the tune was done (presumably `1`,
tuner on; **verify**). FTX Deck ends its TUNING state when `AC;` reads P3 = 0, or
when the tuning carrier has come and gone on the PO meter (`RM5;`), or when no
carrier appears within 3 s.

Yaesu's manual gives `AC003;` for the internal tuner. Hamlib's hardware testing
found `AC103;` starts a cycle for INT and EXT alike, and that an ATAS rejects
`AC000;` and needs the `AC12x` forms. An external tuner also needs menu
TUN/LIN PORT SELECT (`EX030103`) set to EXT-TUNER. **verify** INT and EXT on a
real radio.

### Power limits

From Yaesu's specifications; FTX Deck sets the power slider's range from these:

| Configuration | SSB/CW/FM/DATA | AM carrier |
|---|---|---|
| Optima/SPA-1, HF and 50 MHz | 5–100 W | 5–25 W |
| Optima/SPA-1, 70 MHz and up | 5–50 W | 5–13 W |
| Field head, 13.8 V | 0.5–10 W | 0.5–2.5 W |
| Field head, battery | 0.5–6 W | 0.5–1.5 W |

`PC;` is polled, so a change of head (P1) is picked up while connected. CAT has
no read for the power source: a Field head that answers `?;` to more than 6 W is
taken to be on its battery until the next connect. If `PC;` reports more than
the table allows, the radio's figure wins. **verify** that the radio refuses
out-of-range `PC` sets and limits `PC` in AM.

## Meters

- `RMn;` → `RMnvvv000;` raw 0–255 in the first three digits after n.
  n: 1 MAIN S, 2 SUB S, 3 COMP, 4 ALC, 5 PO, 6 SWR, 7 ID, 8 VDD.
  `RM0;` → `RM0mmmsss;` gives the MAIN and SUB S readings together.
- FTX Deck reads the S meter with `RM1;` / `RM2;`. `SM0;` → `SM0nnn;` works
  for MAIN, but on a real radio `SM1;` gets no usable answer, so SUB can't be
  read with `SM`. Seen on hardware with SUB selected in single receive:
  `SM0;` → `SM0000;`, `SM1;` → nothing, `RM1;` → `RM1000000;`, `RM2;` → `RM2109000;`.
- S calibration (Hamlib's, for `SM`; assumed the same for `RM1`/`RM2`, **verify**):
  0=S0, 12=S1, 27=S2, 40=S3, 55=S4, 65=S5, 80=S6, 95=S7, 112=S8, 130=S9,
  150=+10, 172=+20, 190=+30, 220=+40, 240=+50, 255=+60 dB.
- PO (approx., **verify** on Optima): 0→0 W, 10→0.8, 50→8, 100→26, 150→54, 200→92, 250→140.
- SWR (Yaesu default curve, **verify**): 12→1.0, 39→1.35, 65→1.5, 89→2.0, 242→5.0.
- ALC: 0–64 is the normal zone.

## Spectrum scope

The FTX-1 has no known way to send its scope data to a PC. `SS` only changes the
radio's own scope settings (speed, peak, marker, colour, level, span). FTX Deck
draws its waterfall from the USB receive audio instead.
