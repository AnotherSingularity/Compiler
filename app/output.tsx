import { useState, useEffect } from "react";
import {
  ScrollView,
  Text,
  View,
  TouchableOpacity,
  FlatList,
  Platform,
  Alert,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ScreenContainer } from "@/components/screen-container";
type TabName = "output" | "diagnostics" | "mapping" | "labels" | "fb_defs";
interface Diagnostic {
  severity: "INFO" | "WARN" | "MANUAL_PORT" | "ERROR";
  code: string;
  message: string;
  line: number;
}
interface TranslationResult {
  ok: boolean;
  output: string;
  diagnostics: Diagnostic[];
  mappingYaml: string;
  labelsCsv: string;
  fbDefinitions: string;
  udtDefinitions: string;
  stats: {
    inputLines: number;
    outputLines: number;
    warningCount: number;
    manualPortCount: number;
  };
}
const SEVERITY_COLORS: Record<string, string> = {
  INFO: "#6B7280",
  WARN: "#EAB308",
  MANUAL_PORT: "#F97316",
  ERROR: "#EF4444",
};
export default function OutputScreen() {
  const [activeTab, setActiveTab] = useState<TabName>("output");
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [copied, setCopied] = useState(false);
  const router = useRouter();
  useEffect(() => {
    loadResult();
  }, []);
  const loadResult = async () => {
    const data = await AsyncStorage.getItem("last_translation");
    if (data) {
      setResult(JSON.parse(data));
    }
  };
  const handleCopy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };
  const handleDownload = async () => {
    if (!result?.output) return;
    if (Platform.OS as string === "web") {
      // Web: trigger browser download
      const blob = new Blob([result.output], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "translated_output.st";
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    // Native: write file and share
    try {
      const fileUri = FileSystem.documentDirectory + "translated_output.st";
      await FileSystem.writeAsStringAsync(fileUri, result.output, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          mimeType: "text/plain",
          dialogTitle: "Save Translated ST File",
          UTI: "public.plain-text",
        });
      } else {
        Alert.alert("Saved", `File saved to app storage:\n${fileUri}`);
      }
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (error: any) {
      Alert.alert("Error", "Could not save file: " + (error?.message || "Unknown error"));
    }
  };
  const handleDownloadMapping = async () => {
    if (!result?.mappingYaml) return;
    if (Platform.OS as string === "web") {
      const blob = new Blob([result.mappingYaml], { type: "text/yaml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mapping.yaml";
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    try {
      const fileUri = FileSystem.documentDirectory + "mapping.yaml";
      await FileSystem.writeAsStringAsync(fileUri, result.mappingYaml, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          mimeType: "text/yaml",
          dialogTitle: "Save Mapping File",
        });
      }
    } catch (error: any) {
      Alert.alert("Error", "Could not save file: " + (error?.message || "Unknown error"));
    }
  };
  const handleDownloadLabels = async () => {
    if (!result?.labelsCsv) return;
    if (Platform.OS as string === "web") {
      const blob = new Blob([result.labelsCsv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "labels.csv";
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    try {
      const fileUri = FileSystem.documentDirectory + "labels.csv";
      await FileSystem.writeAsStringAsync(fileUri, result.labelsCsv, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          mimeType: "text/csv",
          dialogTitle: "Save Labels CSV",
        });
      }
    } catch (error: any) {
      Alert.alert("Error", "Could not save file: " + (error?.message || "Unknown error"));
    }
  };
  const handleDownloadFbDefs = async () => {
    if (!result?.fbDefinitions) return;
    if (Platform.OS as string === "web") {
      const blob = new Blob([result.fbDefinitions], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "fb_definitions.st";
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    try {
      const fileUri = FileSystem.documentDirectory + "fb_definitions.st";
      await FileSystem.writeAsStringAsync(fileUri, result.fbDefinitions, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          mimeType: "text/plain",
          dialogTitle: "Save FB Definitions",
        });
      }
    } catch (error: any) {
      Alert.alert("Error", "Could not save file: " + (error?.message || "Unknown error"));
    }
  };
  const handleDownloadUdtDefs = async () => {
    if (!result?.udtDefinitions) return;
    if (Platform.OS as string === "web") {
      const blob = new Blob([result.udtDefinitions], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "udt_definitions.txt";
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    try {
      const fileUri = FileSystem.documentDirectory + "udt_definitions.txt";
      await FileSystem.writeAsStringAsync(fileUri, result.udtDefinitions, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          mimeType: "text/plain",
          dialogTitle: "Save UDT Definitions",
        });
      }
    } catch (error: any) {
      Alert.alert("Error", "Could not save file: " + (error?.message || "Unknown error"));
    }
  };
  const handleBack = () => {
    router.back();
  };
  if (!result) {
    return (
      <ScreenContainer className="px-4 pt-4">
        <View className="flex-1 items-center justify-center">
          <Text className="text-foreground text-center text-base">No translation result available.</Text>
          <TouchableOpacity onPress={handleBack} className="mt-4 bg-primary px-6 py-3 rounded-xl">
            <Text className="text-background font-semibold">Go Back</Text>
          </TouchableOpacity>
        </View>
      </ScreenContainer>
    );
  }
  return (
    <ScreenContainer className="px-4 pt-2">
      {/* Header */}
      <View className="flex-row items-center justify-between mb-3 mt-2">
        <TouchableOpacity onPress={handleBack} className="py-2 pr-4">
          <Text className="text-primary font-semibold text-base">← Back</Text>
        </TouchableOpacity>
        <View className="flex-row items-center gap-2">
          <View className={`w-2.5 h-2.5 rounded-full ${result.ok ? "bg-success" : "bg-error"}`} />
          <Text className={`text-sm font-medium ${result.ok ? "text-success" : "text-error"}`}>
            {result.ok ? "Translation Complete" : "Errors Found"}
          </Text>
        </View>
      </View>
      {/* Stats Bar */}
      <View className="flex-row bg-surface rounded-xl p-3 mb-3 border border-border">
        <View className="flex-1 items-center">
          <Text className="text-xs text-muted">Input</Text>
          <Text className="text-base font-bold text-foreground">{result.stats.inputLines}</Text>
          <Text className="text-xs text-muted">lines</Text>
        </View>
        <View className="flex-1 items-center">
          <Text className="text-xs text-muted">Output</Text>
          <Text className="text-base font-bold text-foreground">{result.stats.outputLines}</Text>
          <Text className="text-xs text-muted">lines</Text>
        </View>
        <View className="flex-1 items-center">
          <Text className="text-xs text-muted">Warnings</Text>
          <Text className="text-base font-bold text-warning">{result.stats.warningCount}</Text>
        </View>
        <View className="flex-1 items-center">
          <Text className="text-xs text-muted">Manual</Text>
          <Text className="text-base font-bold" style={{ color: "#F97316" }}>
            {result.stats.manualPortCount}
          </Text>
        </View>
      </View>
      {/* Download Button - prominent */}
      <TouchableOpacity
        onPress={handleDownload}
        className="w-full py-3.5 rounded-xl items-center justify-center bg-success mb-3"
        activeOpacity={0.8}
      >
        <Text className="text-background font-bold text-base">
          Download Translated File (.st)
        </Text>
      </TouchableOpacity>
      {/* Tabs */}
      <View className="flex-row bg-surface rounded-xl p-1 mb-3 border border-border">
        {(["output", "diagnostics", "labels", "mapping", "fb_defs"] as TabName[]).map((tab) => (
          <TouchableOpacity
            key={tab}
            className={`flex-1 py-2.5 rounded-lg items-center ${activeTab === tab ? "bg-primary" : ""}`}
            onPress={() => setActiveTab(tab)}
            activeOpacity={0.7}
          >
            <Text
              className={`text-xs font-semibold capitalize ${activeTab === tab ? "text-background" : "text-muted"}`}
            >
              {tab === "diagnostics" ? `Diag (${result.diagnostics.length})`
                : tab === "fb_defs" ? "FB Defs"
                : tab}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {/* Tab Content */}
      <View className="flex-1">
        {activeTab === "output" && (
          <View className="flex-1">
            <View className="flex-row justify-end mb-2 gap-2">
              <TouchableOpacity
                onPress={() => handleCopy(result.output)}
                className="bg-surface px-4 py-2 rounded-lg border border-border"
                activeOpacity={0.7}
              >
                <Text className="text-sm text-primary font-medium">
                  {copied ? "Copied!" : "Copy All"}
                </Text>
              </TouchableOpacity>
            </View>
            <ScrollView className="flex-1 bg-surface rounded-xl border border-border p-4">
              <Text
                className="text-foreground"
                style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12, lineHeight: 18 }}
                selectable
              >
                {result.output || "// No output generated"}
              </Text>
            </ScrollView>
          </View>
        )}
        {activeTab === "diagnostics" && (
          <FlatList
            data={result.diagnostics}
            keyExtractor={(_, index) => index.toString()}
            renderItem={({ item }) => (
              <View className="bg-surface rounded-xl p-3 mb-2 border border-border">
                <View className="flex-row items-center gap-2 mb-1">
                  <View
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: SEVERITY_COLORS[item.severity] }}
                  />
                  <Text
                    className="text-xs font-bold"
                    style={{ color: SEVERITY_COLORS[item.severity] }}
                  >
                    {item.severity}
                  </Text>
                  <Text className="text-xs text-muted">{item.code}</Text>
                  {item.line > 0 && (
                    <Text className="text-xs text-muted ml-auto">Line {item.line}</Text>
                  )}
                </View>
                <Text className="text-sm text-foreground mt-1">{item.message}</Text>
              </View>
            )}
            ListEmptyComponent={
              <View className="items-center py-8 bg-surface rounded-xl border border-border">
                <Text className="text-success font-semibold text-base">Clean Translation</Text>
                <Text className="text-muted text-sm mt-1">No diagnostics emitted</Text>
              </View>
            }
            contentContainerStyle={{ paddingBottom: 16 }}
          />
        )}
        {activeTab === "mapping" && (
          <View className="flex-1">
            <View className="flex-row justify-end mb-2 gap-2">
              <TouchableOpacity
                onPress={handleDownloadMapping}
                className="bg-surface px-4 py-2 rounded-lg border border-border"
                activeOpacity={0.7}
              >
                <Text className="text-sm text-primary font-medium">Download YAML</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleCopy(result.mappingYaml)}
                className="bg-surface px-4 py-2 rounded-lg border border-border"
                activeOpacity={0.7}
              >
                <Text className="text-sm text-primary font-medium">Copy</Text>
              </TouchableOpacity>
            </View>
            <ScrollView className="flex-1 bg-surface rounded-xl border border-border p-4">
              <Text
                className="text-foreground"
                style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12, lineHeight: 18 }}
                selectable
              >
                {result.mappingYaml || "# No device allocations"}
              </Text>
            </ScrollView>
          </View>
        )}
        {activeTab === "labels" && (
          <View className="flex-1">
            <View className="flex-row justify-end mb-2 gap-2">
              <TouchableOpacity
                onPress={handleDownloadLabels}
                className="bg-surface px-4 py-2 rounded-lg border border-border"
                activeOpacity={0.7}
              >
                <Text className="text-sm text-primary font-medium">Download CSV</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleCopy(result.labelsCsv)}
                className="bg-surface px-4 py-2 rounded-lg border border-border"
                activeOpacity={0.7}
              >
                <Text className="text-sm text-primary font-medium">Copy</Text>
              </TouchableOpacity>
            </View>
            <ScrollView className="flex-1 bg-surface rounded-xl border border-border p-4" horizontal>
              <ScrollView>
                <Text
                  className="text-foreground"
                  style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 11, lineHeight: 16 }}
                  selectable
                >
                  {result.labelsCsv || "Class,Label,DataType,Constant,Comment"}
                </Text>
              </ScrollView>
            </ScrollView>
          </View>
        )}
        {activeTab === "fb_defs" && (
          <View className="flex-1">
            <View className="flex-row justify-end mb-2 gap-2 flex-wrap">
              <TouchableOpacity
                onPress={handleDownloadFbDefs}
                className="bg-surface px-4 py-2 rounded-lg border border-border"
                activeOpacity={0.7}
              >
                <Text className="text-sm text-primary font-medium">Download FBs</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleDownloadUdtDefs}
                className="bg-surface px-4 py-2 rounded-lg border border-border"
                activeOpacity={0.7}
              >
                <Text className="text-sm text-primary font-medium">Download UDTs</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleCopy(result.fbDefinitions)}
                className="bg-surface px-4 py-2 rounded-lg border border-border"
                activeOpacity={0.7}
              >
                <Text className="text-sm text-primary font-medium">Copy</Text>
              </TouchableOpacity>
            </View>
            <ScrollView className="flex-1 bg-surface rounded-xl border border-border p-4">
              <Text
                className="text-foreground"
                style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12, lineHeight: 18 }}
                selectable
              >
                {result.fbDefinitions || "(* No AOI function blocks extracted *)"}
              </Text>
            </ScrollView>
          </View>
        )}
      </View>
    </ScreenContainer>
  );
}
