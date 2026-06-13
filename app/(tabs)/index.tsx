import { useState, useCallback, useRef } from "react";
import {
  ScrollView,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform,
  StyleSheet,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";

import { ScreenContainer } from "@/components/screen-container";
import { trpc } from "@/lib/trpc";

type Direction = "ab2mel" | "mel2ab";

interface TranslationResult {
  ok: boolean;
  output: string;
  diagnostics: Array<{ severity: string; code: string; message: string; line: number }>;
  mappingYaml: string;
  labelsCsv: string;
  stats: { inputLines: number; outputLines: number; warningCount: number; manualPortCount: number; translatedNodes: number };
}

const C = {
  bgBase: "#0a0a0a",
  bgElevated: "#131313",
  rule: "#2a2620",
  textPrimary: "#e8e2d0",
  textMuted: "#9a9382",
  gold: "#c9a961",
  goldDim: "#8a7440",
  sevInfo: "#9a9382",
  sevWarn: "#c9a961",
  sevManual: "#d68a3a",
  sevError: "#b04a3a",
};

export default function TranslateScreen() {
  const [direction, setDirection] = useState<Direction>("ab2mel");
  const [sourceCode, setSourceCode] = useState("");
  const [isTranslating, setIsTranslating] = useState(false);
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [pickedFile, setPickedFile] = useState<{ name: string; size: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const translateMutation = trpc.translate.useMutation();

  const handleDirectionChange = (dir: Direction) => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDirection(dir);
    setResult(null);
  };

  const handlePaste = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) { setSourceCode(text); setPickedFile(null); setResult(null); }
  };

  const handlePickFile = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true });
      if (res.canceled) return;
      const asset = res.assets[0];
      if (!asset) return;
      let content: string;
      if (Platform.OS as string === "web" && asset.file) { content = await asset.file.text(); }
      else { content = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 }); }
      if (content) { setSourceCode(content); setPickedFile({ name: asset.name, size: asset.size || content.length }); setResult(null); }
    } catch { Alert.alert("File Error", "Could not read file."); }
  };

  const handleTranslate = useCallback(async () => {
    if (!sourceCode.trim()) { Alert.alert("No Input", "Upload a file or paste ST code."); return; }
    setIsTranslating(true);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const res = await translateMutation.mutateAsync({ direction, source: sourceCode });
      setResult(res);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 300);
    } catch (error: any) {
      Alert.alert("Error", error?.message || "Translation failed.");
    } finally { setIsTranslating(false); }
  }, [sourceCode, direction, translateMutation]);

  const handleCopyOutput = async () => {
    if (!result?.output) return;
    await Clipboard.setStringAsync(result.output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = async () => {
    if (!result?.output) return;
    const filename = direction === "ab2mel" ? "translated_MEL.st" : "translated_AB.st";
    if (Platform.OS as string === "web") {
      const blob = new Blob([result.output], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return;
    }
    try {
      const fileUri = `${FileSystem.cacheDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(fileUri, result.output, { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, { mimeType: "text/plain", dialogTitle: `Save ${filename}`, UTI: "public.plain-text" });
      } else { Alert.alert("Saved", `File saved: ${filename}`); }
    } catch (err: any) { Alert.alert("Error", err?.message || "Could not save file."); }
  };

  const sevColor = (sev: string) => sev === "ERROR" ? C.sevError : sev === "MANUAL_PORT" ? C.sevManual : sev === "WARN" ? C.sevWarn : C.sevInfo;

  return (
    <ScreenContainer containerClassName="bg-background">
      <ScrollView ref={scrollRef} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        {/* Wordmark */}
        <View style={{ alignItems: "center", marginTop: 24, marginBottom: 8 }}>
          <Text style={s.wordmark}>ST Compiler</Text>
          <Text style={s.subtitle}>Allen-Bradley ↔ Mitsubishi</Text>
        </View>

        {/* Direction toggle */}
        <View style={s.dirRow}>
          <TouchableOpacity onPress={() => handleDirectionChange("ab2mel")} activeOpacity={0.7}>
            <Text style={[s.dirText, direction === "ab2mel" && s.dirActive]}>AB → MEL</Text>
          </TouchableOpacity>
          <Text style={s.dirSep}>│</Text>
          <TouchableOpacity onPress={() => handleDirectionChange("mel2ab")} activeOpacity={0.7}>
            <Text style={[s.dirText, direction === "mel2ab" && s.dirActive]}>MEL → AB</Text>
          </TouchableOpacity>
        </View>

        {/* File upload */}
        <View style={s.hairline} />
        <TouchableOpacity onPress={handlePickFile} style={s.uploadArea} activeOpacity={0.7}>
          {pickedFile ? (
            <Text style={s.uploadLoaded}>{pickedFile.name} — {(pickedFile.size / 1024).toFixed(1)} KB</Text>
          ) : (
            <Text style={s.uploadPrompt}>Drop an .L5X or .st file, or tap to select</Text>
          )}
        </TouchableOpacity>
        <View style={s.hairline} />

        {/* Paste */}
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 16, marginBottom: 8 }}>
          <Text style={s.label}>Or paste code</Text>
          <TouchableOpacity onPress={handlePaste}><Text style={s.actionLink}>Paste from clipboard</Text></TouchableOpacity>
        </View>

        {/* Code input */}
        <View style={s.inputBorder}>
          <TextInput
            style={s.codeInput}
            multiline
            textAlignVertical="top"
            placeholder={direction === "ab2mel" ? "// AB Structured Text\nIF RunMode THEN\n  Speed := SetPoint * 0.95;\n  TON(RunTimer);\nEND_IF;" : "// MEL Structured Text\nIF M100 THEN\n  RunTimer(IN := M100, PT := T#5000);\nEND_IF;"}
            placeholderTextColor={C.textMuted}
            value={sourceCode}
            onChangeText={(t) => { setSourceCode(t); setPickedFile(null); setResult(null); }}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
          />
        </View>

        {/* Compile button */}
        <TouchableOpacity onPress={handleTranslate} disabled={isTranslating} style={s.compileBtn} activeOpacity={0.7}>
          {isTranslating ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ActivityIndicator color={C.gold} size="small" />
              <Text style={s.compileBtnText}>Compiling…</Text>
            </View>
          ) : (
            <Text style={s.compileBtnText}>Compile & Translate</Text>
          )}
        </TouchableOpacity>

        {/* === OUTPUT === */}
        {result && (
          <View style={{ marginTop: 32 }}>
            <View style={s.hairline} />

            {/* Stats line */}
            <Text style={s.statsLine}>
              <Text>{result.stats.inputLines} lines in</Text>
              <Text style={s.statsSep}> · </Text>
              <Text>{result.stats.outputLines} lines out</Text>
              <Text style={s.statsSep}> · </Text>
              <Text>{result.stats.translatedNodes} nodes</Text>
              <Text style={s.statsSep}> · </Text>
              <Text style={result.stats.manualPortCount > 0 ? { color: C.sevManual } : undefined}>{result.stats.manualPortCount} manual port</Text>
              <Text style={s.statsSep}> · </Text>
              <Text style={result.stats.warningCount > 0 ? { color: C.sevWarn } : undefined}>{result.stats.warningCount} warnings</Text>
            </Text>

            {/* Actions */}
            <View style={{ flexDirection: "row", gap: 24, marginTop: 16, marginBottom: 16 }}>
              <TouchableOpacity onPress={handleDownload}><Text style={s.actionLink}>Download .st</Text></TouchableOpacity>
              <TouchableOpacity onPress={handleCopyOutput}><Text style={s.actionLink}>{copied ? "Copied" : "Copy output"}</Text></TouchableOpacity>
            </View>

            {/* Output code */}
            <ScrollView style={s.outputScroll} nestedScrollEnabled>
              <Text style={s.codeOutput} selectable>{result.output}</Text>
            </ScrollView>

            {/* Diagnostics */}
            {result.diagnostics.length > 0 && (
              <View style={{ marginTop: 24 }}>
                <Text style={s.sectionHead}>Diagnostics</Text>
                <View style={s.hairline} />
                {result.diagnostics.map((d, i) => (
                  <View key={i} style={s.diagRow}>
                    <Text style={[s.diagSev, { color: sevColor(d.severity) }]}>
                      {d.severity === "MANUAL_PORT" ? "M" : d.severity[0]}
                    </Text>
                    <Text style={s.diagCode}>{d.code}</Text>
                    <Text style={s.diagMsg}>{d.message}</Text>
                    {d.line > 0 && <Text style={s.diagLine}>{d.line}</Text>}
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  wordmark: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 28, fontWeight: "500", color: C.gold, letterSpacing: 0.3 },
  subtitle: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 14, fontStyle: "italic", color: C.textMuted, marginTop: 4 },
  dirRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", marginVertical: 20, gap: 16 },
  dirText: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 16, color: C.textMuted },
  dirActive: { color: C.gold },
  dirSep: { color: C.rule, fontSize: 16 },
  hairline: { height: 1, backgroundColor: C.rule, marginVertical: 12 },
  uploadArea: { paddingVertical: 20, alignItems: "center" },
  uploadPrompt: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 15, fontStyle: "italic", color: C.textMuted, textAlign: "center" },
  uploadLoaded: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 15, color: C.gold, textAlign: "center" },
  label: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 15, color: C.textPrimary },
  actionLink: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 14, fontStyle: "italic", color: C.gold },
  inputBorder: { borderWidth: 1, borderColor: C.rule, borderRadius: 2, marginBottom: 20 },
  codeInput: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 13, lineHeight: 19, color: C.textPrimary, backgroundColor: C.bgBase, padding: 16, minHeight: 180, textAlignVertical: "top" },
  compileBtn: { borderWidth: 1, borderColor: C.gold, borderRadius: 2, paddingVertical: 14, alignItems: "center" },
  compileBtnText: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 15, color: C.gold, letterSpacing: 1.5, textTransform: "uppercase" },
  statsLine: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 13, fontStyle: "italic", color: C.textMuted, marginTop: 12 },
  statsSep: { color: C.rule },
  outputScroll: { maxHeight: 400, borderWidth: 1, borderColor: C.rule, borderRadius: 2, padding: 16, backgroundColor: C.bgBase },
  codeOutput: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12, lineHeight: 18, color: C.textPrimary },
  sectionHead: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 18, fontWeight: "500", color: C.textPrimary, marginBottom: 8 },
  diagRow: { flexDirection: "row", alignItems: "flex-start", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.rule, gap: 8 },
  diagSev: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 13, fontWeight: "700", width: 16 },
  diagCode: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 11, color: C.textMuted },
  diagMsg: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 13, color: C.textPrimary, flex: 1 },
  diagLine: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12, color: C.gold },
});
