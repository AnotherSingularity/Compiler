# AB↔MEL ST Compiler — Mobile App Design

## Screen List

1. **Translate** (Home) — Main translation screen with input and direction toggle
2. **Output** — Shows translated code, diagnostics, and memory mapping
3. **History** — List of past translations stored locally

## Primary Content and Functionality

### Translate Screen (Home Tab)
- Direction toggle: large segmented control (AB → MEL / MEL → AB)
- Input area: monospace text editor for pasting ST code (scrollable, min 12 lines)
- File attach button: pick L5X file from device (AB→MEL direction only)
- Advanced options (collapsible): memory_map.yaml upload, labels.csv upload
- Full-width "Translate" button with loading spinner state
- Quick-paste from clipboard button

### Output Screen (shown after translation)
- Segmented tabs: Output | Diagnostics | Mapping
- Output tab: syntax-highlighted ST code with copy and share buttons
- Diagnostics tab: color-coded list (INFO=gray, WARN=yellow, MANUAL_PORT=orange, ERROR=red)
- Mapping tab: device allocation YAML with copy button
- Stats bar: input lines, output lines, warnings, manual ports

### History Screen (Tab)
- FlatList of past translations (direction, timestamp, line count)
- Tap to view full output
- Swipe to delete

## Key User Flows

1. **Translate AB→MEL:** User selects AB→MEL → pastes ST code (or picks L5X file) → taps Translate → sees output on Output screen
2. **Translate MEL→AB:** User selects MEL→AB → pastes MEL ST code → taps Translate → sees AB output
3. **View Diagnostics:** After translation → swipe to Diagnostics tab → see severity-coded issues
4. **Copy Output:** On Output tab → tap Copy → code copied to clipboard with haptic feedback
5. **Re-run from History:** History tab → tap entry → view previous output → tap "Re-translate" to run again

## Color Choices

- **Primary:** #2563EB (electric blue — industrial/technical feel)
- **Background:** #0F172A (dark navy)
- **Surface:** #1E293B (slate card background)
- **Foreground:** #F1F5F9 (near-white text)
- **Muted:** #94A3B8 (slate-400 for secondary text)
- **Success:** #22C55E (green — translation complete)
- **Warning:** #EAB308 (amber — compiler warnings)
- **Error:** #EF4444 (red — parse/compile errors)
- **Manual Port:** #F97316 (orange — requires manual intervention)
- **Border:** #334155 (subtle slate dividers)
