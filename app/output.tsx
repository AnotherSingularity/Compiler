import { useState, useEffect } from "react";
import {
  ScrollView,
  Text,
  View,
  TouchableOpacity,
  FlatList,
  Platform,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { ScreenContainer } from "@/components/screen-container";

type TabName = "output" | "diagnostics" | "mapping";

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
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const handleBack = () => {
    router.back();
  };

  if (!result) {
    return (
      <ScreenContainer className="px-4 pt-4">
        <Text className="text-foreground text-center mt-10">No translation result available.</Text>
        <TouchableOpacity onPress={handleBack} className="mt-4 items-center">
          <Text className="text-primary font-semibold">Go Back</Text>
        </TouchableOpacity>
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
          <View className={`w-2 h-2 rounded-full ${result.ok ? "bg-success" : "bg-error"}`} />
          <Text className="text-sm text-muted">{result.ok ? "Success" : "Errors"}</Text>
        </View>
      </View>

      {/* Stats Bar */}
      <View className="flex-row bg-surface rounded-xl p-3 mb-3 border border-border">
        <View className="flex-1 items-center">
          <Text className="text-xs text-muted">In</Text>
          <Text className="text-sm font-semibold text-foreground">{result.stats.inputLines}</Text>
        </View>
        <View className="flex-1 items-center">
          <Text className="text-xs text-muted">Out</Text>
          <Text className="text-sm font-semibold text-foreground">{result.stats.outputLines}</Text>
        </View>
        <View className="flex-1 items-center">
          <Text className="text-xs text-muted">Warn</Text>
          <Text className="text-sm font-semibold text-warning">{result.stats.warningCount}</Text>
        </View>
        <View className="flex-1 items-center">
          <Text className="text-xs text-muted">Manual</Text>
          <Text className="text-sm font-semibold" style={{ color: "#F97316" }}>
            {result.stats.manualPortCount}
          </Text>
        </View>
      </View>

      {/* Tabs */}
      <View className="flex-row bg-surface rounded-xl p-1 mb-3 border border-border">
        {(["output", "diagnostics", "mapping"] as TabName[]).map((tab) => (
          <TouchableOpacity
            key={tab}
            className={`flex-1 py-2.5 rounded-lg items-center ${activeTab === tab ? "bg-primary" : ""}`}
            onPress={() => setActiveTab(tab)}
            activeOpacity={0.7}
          >
            <Text
              className={`text-xs font-semibold capitalize ${activeTab === tab ? "text-background" : "text-muted"}`}
            >
              {tab === "diagnostics" ? `Diag (${result.diagnostics.length})` : tab}
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
                className="bg-surface px-3 py-1.5 rounded-lg border border-border"
                activeOpacity={0.7}
              >
                <Text className="text-xs text-primary font-medium">Copy</Text>
              </TouchableOpacity>
            </View>
            <ScrollView className="flex-1 bg-surface rounded-xl border border-border p-4">
              <Text
                className="text-foreground"
                style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12, lineHeight: 18 }}
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
                    className="w-2 h-2 rounded-full"
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
                    <Text className="text-xs text-muted">Line {item.line}</Text>
                  )}
                </View>
                <Text className="text-sm text-foreground">{item.message}</Text>
              </View>
            )}
            ListEmptyComponent={
              <View className="items-center py-8">
                <Text className="text-success font-medium">No diagnostics — clean translation</Text>
              </View>
            }
          />
        )}

        {activeTab === "mapping" && (
          <View className="flex-1">
            <View className="flex-row justify-end mb-2 gap-2">
              <TouchableOpacity
                onPress={() => handleCopy(result.mappingYaml)}
                className="bg-surface px-3 py-1.5 rounded-lg border border-border"
                activeOpacity={0.7}
              >
                <Text className="text-xs text-primary font-medium">Copy</Text>
              </TouchableOpacity>
            </View>
            <ScrollView className="flex-1 bg-surface rounded-xl border border-border p-4">
              <Text
                className="text-foreground"
                style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12, lineHeight: 18 }}
              >
                {result.mappingYaml || "# No allocations"}
              </Text>
            </ScrollView>
          </View>
        )}
      </View>
    </ScreenContainer>
  );
}
