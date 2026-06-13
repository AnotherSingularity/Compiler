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
  failureReport?: { stage: string; error: string; traceback: string; sourceContext: string; pipelineState: string; timestamp: string; direction: string; inputLines: number } | null;
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

interface ValidationResult {
  ok: boolean;
  verdict?: string;
  concerns?: Array<{ severity: string; line: number; message: string }>;
  summary?: string;
  costCents?: number;
  tokensIn?: number;
  tokensOut?: number;
  error_code?: string;
  message?: string;
}

export default function TranslateScreen() {
  const [direction, setDirection] = useState<Direction>("ab2mel");
  const [sourceCode, setSourceCode] = useState("");
  const [isTranslating, setIsTranslating] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [translationId, setTranslationId] = useState<number | null>(null);
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

  const validateMutation = trpc.validate.useMutation();

  const handleTranslate = useCallback(async () => {
    if (!sourceCode.trim()) { Alert.alert("No Input", "Upload a file or paste ST code."); return; }
    setIsTranslating(true);
    setValidation(null);
    setTranslationId(null);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const res = await translateMutation.mutateAsync({ direction, source: sourceCode });
      setResult(res);
      if ((res as any).translationId) setTranslationId((res as any).translationId);
      // Check for empty output with non-empty input (pipeline failure)
      if (res.ok && (!res.output || res.output.trim() === "") && sourceCode.trim()) {
        setResult({
          ...res,
          ok: false,
          failureReport: {
            stage: "emit_mel",
            error: "Pipeline produced empty output for non-empty input",
            traceback: "No exception — output was empty string",
            sourceContext: sourceCode.substring(0, 200),
            pipelineState: `translatedNodes: ${res.stats.translatedNodes}`,
            timestamp: new Date().toISOString(),
            direction,
            inputLines: res.stats.inputLines,
          },
        });
      }
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 300);
    } catch (error: any) {
      // HTTP error or network failure — produce a failure report, not just an alert
      const failureReport = {
        stage: "route_handler" as const,
        error: error?.message || "Unknown error",
        traceback: error?.data?.stack || error?.stack || error?.message || "No traceback available",
        sourceContext: sourceCode.substring(0, 200),
        pipelineState: "Request failed before pipeline could execute",
        timestamp: new Date().toISOString(),
        direction,
        inputLines: sourceCode.split("\n").length,
      };
      setResult({
        ok: false,
        output: "",
        diagnostics: [{ severity: "ERROR", code: "HTTP_ERROR", message: error?.message || "Request failed", line: 0 }],
        mappingYaml: "",
        labelsCsv: "",
        failureReport,
        stats: { inputLines: sourceCode.split("\n").length, outputLines: 0, warningCount: 0, manualPortCount: 0, translatedNodes: 0 },
      });
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 300);
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
            <View style={{ flexDirection: "row", gap: 24, marginTop: 16, marginBottom: 16, flexWrap: "wrap" }}>
              <TouchableOpacity onPress={handleDownload}><Text style={s.actionLink}>Download .st</Text></TouchableOpacity>
              <TouchableOpacity onPress={handleCopyOutput}><Text style={s.actionLink}>{copied ? "Copied" : "Copy output"}</Text></TouchableOpacity>
              {translationId && (
                <TouchableOpacity
                  onPress={async () => {
                    if (!translationId || isValidating) return;
                    setIsValidating(true);
                    try {
                      const res = await validateMutation.mutateAsync({ translationId });
                      setValidation(res as ValidationResult);
                    } catch (e: any) {
                      setValidation({ ok: false, message: e?.message || "Validation failed" });
                    } finally { setIsValidating(false); }
                  }}
                  disabled={isValidating}
                >
                  <Text style={[s.actionLink, isValidating && { color: C.textMuted }]}>
                    {isValidating ? "Validating..." : "Validate with AI"}
                  </Text>
                </TouchableOpacity>
              )}
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

            {/* Validation Results (opt-in, post-hoc) */}
            {validation && (
              <View style={{ marginTop: 24 }}>
                <Text style={s.sectionHead}>Validation</Text>
                <View style={s.hairline} />
                {validation.ok && validation.verdict ? (
                  <View style={{ marginTop: 8 }}>
                    <Text style={[s.statsLine, {
                      color: validation.verdict === "equivalent" ? C.gold
                        : validation.verdict === "concerns" ? C.sevWarn
                        : C.textMuted,
                      fontStyle: "normal", fontSize: 16, fontWeight: "500"
                    }]}>
                      {validation.verdict === "equivalent" ? "Equivalent"
                        : validation.verdict === "concerns" ? "Concerns found"
                        : "Could not determine"}
                    </Text>
                    {validation.summary && (
                      <Text style={{ fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 14, color: C.textPrimary, marginTop: 8, lineHeight: 22 }}>
                        {validation.summary}
                      </Text>
                    )}
                    {validation.concerns && validation.concerns.length > 0 && (
                      <View style={{ marginTop: 12 }}>
                        {validation.concerns.map((c, i) => (
                          <View key={i} style={s.diagRow}>
                            <Text style={[s.diagSev, { color: c.severity === "error" ? C.sevError : c.severity === "warn" ? C.sevWarn : C.sevInfo }]}>
                              {c.severity[0].toUpperCase()}
                            </Text>
                            <Text style={s.diagMsg}>{c.message}</Text>
                            {c.line > 0 && <Text style={s.diagLine}>{c.line}</Text>}
                          </View>
                        ))}
                      </View>
                    )}
                    <Text style={{ fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 11, fontStyle: "italic", color: C.textMuted, marginTop: 12 }}>
                      Validation by AI · {((validation.costCents || 0) / 100).toFixed(2)}¢ · {(validation.tokensIn || 0) + (validation.tokensOut || 0)} tokens · advisory only
                    </Text>
                  </View>
                ) : (
                  <Text style={{ fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 14, color: C.sevError, marginTop: 8 }}>
                    {validation.message || "Validation failed"}
                  </Text>
                )}
              </View>
            )}

            {/* Failures Tab (visible only when errors/exceptions occurred) */}
            {(result.failureReport || result.diagnostics.some(d => d.severity === "ERROR") || (!result.ok && !result.output)) && (
              <View style={{ marginTop: 24 }}>
                <Text style={s.sectionHead}>Failures</Text>
                <View style={s.hairline} />
                <TouchableOpacity
                  onPress={() => {
                    const fr = result.failureReport;
                    const sourceKind = pickedFile?.name?.endsWith(".L5X") ? "l5x_base64" : pickedFile?.name?.endsWith(".l5k") ? "l5k_text" : "st_text";
                    const report = `=== FAILURE REPORT ===\ntimestamp: ${fr?.timestamp || new Date().toISOString()}\ndirection: ${direction}\nsource_kind: ${sourceKind}\nstage: ${fr?.stage || "unknown"}\ninput_lines: ${fr?.inputLines || result.stats.inputLines}\n\n--- ERROR ---\n${fr?.error || result.diagnostics.filter(d => d.severity === "ERROR").map(d => `[${d.code}] ${d.message}`).join("\n") || "Unknown error"}\n\n--- TRACEBACK ---\n${fr?.traceback || "No traceback (diagnostic-level error, not exception)"}\n\n--- INPUT (first 200 chars) ---\n${sourceCode.substring(0, 200)}\n\n--- COUNTERS ---\nroutines_discovered: ${result.stats.inputLines}\nroutines_emitted: ${result.stats.translatedNodes}\nlast_successful_stage: ${fr ? (fr.stage === "parser" ? "init" : "parser") : "emit"}\n\n--- SOURCE CONTEXT ---\n${fr?.sourceContext || "(see input above)"}\n\n--- PIPELINE STATE ---\n${fr?.pipelineState || `translatedNodes: ${result.stats.translatedNodes}, manualPortCount: ${result.stats.manualPortCount}`}\n\n=== END REPORT ===`;
                    Clipboard.setStringAsync(report);
                  }}
                  style={{ marginTop: 8, marginBottom: 12 }}
                >
                  <Text style={s.actionLink}>Copy failure report</Text>
                </TouchableOpacity>
                <ScrollView style={s.outputScroll} nestedScrollEnabled>
                  <Text style={s.codeOutput} selectable>
{(() => {
  const fr = result.failureReport;
  const sourceKind = pickedFile?.name?.endsWith(".L5X") ? "l5x_base64" : pickedFile?.name?.endsWith(".l5k") ? "l5k_text" : "st_text";
  return `=== FAILURE REPORT ===
timestamp: ${fr?.timestamp || new Date().toISOString()}
direction: ${direction}
source_kind: ${sourceKind}
stage: ${fr?.stage || "unknown"}
input_lines: ${fr?.inputLines || result.stats.inputLines}

--- ERROR ---
${fr?.error || result.diagnostics.filter(d => d.severity === "ERROR").map(d => `[${d.code}] ${d.message}`).join("\n") || "Unknown error"}

--- TRACEBACK ---
${fr?.traceback || "No traceback (diagnostic-level error, not exception)"}

--- INPUT (first 200 chars) ---
${sourceCode.substring(0, 200)}

--- COUNTERS ---
routines_discovered: ${result.stats.inputLines}
routines_emitted: ${result.stats.translatedNodes}
last_successful_stage: ${fr ? (fr.stage === "parser" ? "init" : "parser") : "emit"}

--- SOURCE CONTEXT ---
${fr?.sourceContext || "(see input above)"}

--- PIPELINE STATE ---
${fr?.pipelineState || `translatedNodes: ${result.stats.translatedNodes}, manualPortCount: ${result.stats.manualPortCount}`}

=== END REPORT ===`;
})()}
                  </Text>
                </ScrollView>
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
