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
| IF shift | `IS0` + on + sign + `nnnn` e.g. `IS01+0200;` | ±1200 Hz |
| Noise blanker | `NL0nnn;` | 000 = off, 001–010 |
| DNR | `RL0nn;` | 00 = off, 01–10 |
| DNF (auto notch) | `BC0n;` | 0/1 |
| Manual notch on/off | `BP00nnn;` | 000 off, 001 on |
| Manual notch freq | `BP01nnn;` | 001–320 × 10 Hz |
| Contour on/off | `CO00nnnn;` | 0000/0001 |
| Contour freq | `CO01nnnn;` | 0010–3200 Hz |
| APF on/off | `CO02nnnn;` | CW only |
| Narrow | `NA0n;` | 0/1 |

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
| Tuner | `AC003;` start tune (internal), `AC000;` stop. `AC;` → P3 ≠ 0 while tuning | ATAS uses `AC123;`/`AC120;`. Internal tuner needs Optima/SPA-1 |
| Key speed | `KSnnn;` | 004–060 wpm |
| Key pitch | `KPnn;` | 00–75 → 300–1050 Hz in 10 Hz steps |

## Meters

- `SM0;` → `SM0nnn;` raw 0–255. Hamlib's calibration: 0=S0, 12=S1, 27=S2,
  40=S3, 55=S4, 65=S5, 80=S6, 95=S7, 112=S8, 130=S9, 150=+10, 172=+20,
  190=+30, 220=+40, 240=+50, 255=+60 dB.
- `RMn;` → `RMnvvv…;` raw 0–255 in the first three digits after n.
  n: 1 MAIN S, 2 SUB S, 3 COMP, 4 ALC, 5 PO, 6 SWR, 7 ID, 8 VDD.
- PO (approx., **verify** on Optima): 0→0 W, 10→0.8, 50→8, 100→26, 150→54, 200→92, 250→140.
- SWR (Yaesu default curve, **verify**): 12→1.0, 39→1.35, 65→1.5, 89→2.0, 242→5.0.
- ALC: 0–64 is the normal zone.

## Spectrum scope

The FTX-1 has no known way to send its scope data to a PC. `SS` only changes the
radio's own scope settings (speed, peak, marker, colour, level, span). FTX Deck
draws its waterfall from the USB receive audio instead.
