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
  stats: { inputLines: number; outputLines: number; warningCount: number; manualPortCount: number };
}

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
    if (text) {
      setSourceCode(text);
      setPickedFile(null);
      setResult(null);
      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const handlePickFile = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ["text/plain", "text/xml", "application/xml", "application/octet-stream", "*/*"],
        copyToCacheDirectory: true,
      });
      if (res.canceled) return;
      const asset = res.assets[0];
      if (!asset) return;

      let content: string;
      if (Platform.OS as string === "web" && asset.file) {
        content = await asset.file.text();
      } else {
        content = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
      }

      if (content) {
        setSourceCode(content);
        setPickedFile({ name: asset.name, size: asset.size || content.length });
        setResult(null);
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch {
      Alert.alert("File Error", "Could not read file. Make sure it's a text file (.st, .txt, .L5X).");
    }
  };

  const handleTranslate = useCallback(async () => {
    if (!sourceCode.trim()) {
      Alert.alert("No Input", "Upload a file or paste ST code first.");
      return;
    }
    setIsTranslating(true);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const res = await translateMutation.mutateAsync({ direction, source: sourceCode });
      setResult(res);
      // Scroll to output
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 300);
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(res.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error);
      }
    } catch (error: any) {
      Alert.alert("Error", error?.message || "Translation failed.");
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsTranslating(false);
    }
  }, [sourceCode, direction, translateMutation]);

  const handleCopyOutput = async () => {
    if (!result?.output) return;
    await Clipboard.setStringAsync(result.output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleDownload = async () => {
    if (!result?.output) return;

    const filename = direction === "ab2mel" ? "translated_MEL.st" : "translated_AB.st";

    if (Platform.OS as string === "web") {
      const blob = new Blob([result.output], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return;
    }

    // Android/iOS: write to cache then share
    try {
      const fileUri = `${FileSystem.cacheDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(fileUri, result.output, { encoding: FileSystem.EncodingType.UTF8 });

      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(fileUri, {
          mimeType: "text/plain",
          dialogTitle: `Save ${filename}`,
          UTI: "public.plain-text",
        });
      } else {
        // Fallback: copy to documents dir
        const docUri = `${FileSystem.documentDirectory}${filename}`;
        await FileSystem.copyAsync({ from: fileUri, to: docUri });
        Alert.alert("Saved", `File saved to app documents:\n${filename}`);
      }
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      Alert.alert("Download Error", err?.message || "Could not save file.");
    }
  };

  return (
    <ScreenContainer className="px-4 pt-2">
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View className="items-center mb-3 mt-2">
          <Text className="text-2xl font-bold text-foreground">AB↔MEL Compiler</Text>
          <Text className="text-sm text-muted mt-1">Structured Text Translation</Text>
        </View>

        {/* Direction Toggle */}
        <View className="flex-row bg-surface rounded-xl p-1 mb-4 border border-border">
          <TouchableOpacity
            className={`flex-1 py-3 rounded-lg items-center ${direction === "ab2mel" ? "bg-primary" : ""}`}
            onPress={() => handleDirectionChange("ab2mel")}
            activeOpacity={0.7}
          >
            <Text className={`font-bold text-base ${direction === "ab2mel" ? "text-background" : "text-muted"}`}>
              AB → MEL
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            className={`flex-1 py-3 rounded-lg items-center ${direction === "mel2ab" ? "bg-primary" : ""}`}
            onPress={() => handleDirectionChange("mel2ab")}
            activeOpacity={0.7}
          >
            <Text className={`font-bold text-base ${direction === "mel2ab" ? "text-background" : "text-muted"}`}>
              MEL → AB
            </Text>
          </TouchableOpacity>
        </View>

        {/* File Upload */}
        <TouchableOpacity
          onPress={handlePickFile}
          className="bg-surface border-2 border-dashed border-primary/40 rounded-xl p-5 items-center mb-3"
          activeOpacity={0.7}
        >
          {pickedFile ? (
            <View className="items-center">
              <Text className="text-success font-bold text-base">File Loaded</Text>
              <Text className="text-sm text-muted mt-1">{pickedFile.name} ({(pickedFile.size / 1024).toFixed(1)} KB)</Text>
            </View>
          ) : (
            <View className="items-center">
              <Text className="text-primary font-bold text-base">Upload ST File</Text>
              <Text className="text-xs text-muted mt-1">.st, .txt, .L5X — tap to browse</Text>
            </View>
          )}
        </TouchableOpacity>

        {/* Or paste */}
        <View className="flex-row justify-between items-center mb-2">
          <Text className="text-sm font-medium text-foreground">Or paste code directly</Text>
          <TouchableOpacity onPress={handlePaste} className="bg-primary/10 px-3 py-1.5 rounded-lg" activeOpacity={0.7}>
            <Text className="text-xs text-primary font-bold">Paste from Clipboard</Text>
          </TouchableOpacity>
        </View>

        <TextInput
          className="bg-surface border border-border rounded-xl p-4 text-foreground min-h-[180px] mb-4"
          style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 13, lineHeight: 20 }}
          multiline
          textAlignVertical="top"
          placeholder={direction === "ab2mel"
            ? "// AB Structured Text\nIF RunMode THEN\n  Speed := SetPoint * 0.95;\n  TON(RunTimer);\nEND_IF;"
            : "// MEL Structured Text\nIF M100 THEN\n  RunTimer(IN := M100, PT := T#5000);\nEND_IF;"
          }
          placeholderTextColor="#64748B"
          value={sourceCode}
          onChangeText={(t) => { setSourceCode(t); setPickedFile(null); setResult(null); }}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />

        {/* Translate Button */}
        <TouchableOpacity
          className={`w-full py-4 rounded-xl items-center ${isTranslating ? "bg-primary/60" : "bg-primary"}`}
          onPress={handleTranslate}
          disabled={isTranslating}
          activeOpacity={0.8}
        >
          {isTranslating ? (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator color="white" size="small" />
              <Text className="text-background font-bold text-lg">Compiling...</Text>
            </View>
          ) : (
            <Text className="text-background font-bold text-lg">Compile & Translate</Text>
          )}
        </TouchableOpacity>

        {/* === OUTPUT SECTION === */}
        {result && (
          <View className="mt-6">
            {/* Status */}
            <View className="flex-row items-center gap-2 mb-3">
              <View className={`w-3 h-3 rounded-full ${result.ok ? "bg-success" : "bg-error"}`} />
              <Text className={`font-bold text-base ${result.ok ? "text-success" : "text-error"}`}>
                {result.ok ? "Translation Complete" : "Translation Has Errors"}
              </Text>
            </View>

            {/* Stats */}
            <View className="flex-row bg-surface rounded-xl p-3 mb-3 border border-border">
              <View className="flex-1 items-center">
                <Text className="text-lg font-bold text-foreground">{result.stats.inputLines}</Text>
                <Text className="text-xs text-muted">Input Lines</Text>
              </View>
              <View className="flex-1 items-center">
                <Text className="text-lg font-bold text-foreground">{result.stats.outputLines}</Text>
                <Text className="text-xs text-muted">Output Lines</Text>
              </View>
              <View className="flex-1 items-center">
                <Text className="text-lg font-bold text-warning">{result.stats.warningCount}</Text>
                <Text className="text-xs text-muted">Warnings</Text>
              </View>
              <View className="flex-1 items-center">
                <Text className="text-lg font-bold" style={{ color: "#F97316" }}>{result.stats.manualPortCount}</Text>
                <Text className="text-xs text-muted">Manual</Text>
              </View>
            </View>

            {/* Download Button — BIG and obvious */}
            <TouchableOpacity
              onPress={handleDownload}
              className="w-full py-4 rounded-xl items-center bg-success mb-3"
              activeOpacity={0.8}
            >
              <Text className="text-background font-bold text-lg">
                Download {direction === "ab2mel" ? "MEL" : "AB"} File (.st)
              </Text>
            </TouchableOpacity>

            {/* Copy Button */}
            <TouchableOpacity
              onPress={handleCopyOutput}
              className="w-full py-3 rounded-xl items-center bg-surface border border-border mb-4"
              activeOpacity={0.7}
            >
              <Text className="text-primary font-bold">{copied ? "Copied to Clipboard!" : "Copy Output to Clipboard"}</Text>
            </TouchableOpacity>

            {/* Output Code */}
            <Text className="text-sm font-bold text-foreground mb-2">Translated Output:</Text>
            <View className="bg-surface rounded-xl border border-border p-4 max-h-[400px]">
              <ScrollView nestedScrollEnabled>
                <Text
                  className="text-foreground"
                  style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12, lineHeight: 18 }}
                  selectable
                >
                  {result.output}
                </Text>
              </ScrollView>
            </View>

            {/* Diagnostics */}
            {result.diagnostics.length > 0 && (
              <View className="mt-4">
                <Text className="text-sm font-bold text-foreground mb-2">
                  Diagnostics ({result.diagnostics.length}):
                </Text>
                {result.diagnostics.map((d, i) => (
                  <View key={i} className="bg-surface rounded-lg p-3 mb-2 border border-border">
                    <View className="flex-row items-center gap-2">
                      <View className="w-2 h-2 rounded-full" style={{
                        backgroundColor: d.severity === "ERROR" ? "#EF4444" : d.severity === "WARN" ? "#EAB308" : d.severity === "MANUAL_PORT" ? "#F97316" : "#6B7280"
                      }} />
                      <Text className="text-xs font-bold" style={{
                        color: d.severity === "ERROR" ? "#EF4444" : d.severity === "WARN" ? "#EAB308" : d.severity === "MANUAL_PORT" ? "#F97316" : "#6B7280"
                      }}>{d.severity}</Text>
                      <Text className="text-xs text-muted">Line {d.line}</Text>
                    </View>
                    <Text className="text-sm text-foreground mt-1">{d.message}</Text>
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
