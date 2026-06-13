import { useState, useCallback } from "react";
import {
  Text,
  View,
  TouchableOpacity,
  FlatList,
  Alert,
  Platform,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useFocusEffect, useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { ScreenContainer } from "@/components/screen-container";

interface HistoryEntry {
  id: string;
  direction: "ab2mel" | "mel2ab";
  timestamp: string;
  inputLines: number;
  outputLines: number;
  warningCount: number;
  manualPortCount: number;
  source: string;
  output: string;
  diagnostics: any[];
  mappingYaml?: string;
  ok: boolean;
}

export default function HistoryScreen() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const router = useRouter();

  useFocusEffect(
    useCallback(() => {
      loadHistory();
    }, [])
  );

  const loadHistory = async () => {
    const data = await AsyncStorage.getItem("translation_history");
    if (data) {
      setHistory(JSON.parse(data));
    }
  };

  const handleViewEntry = async (entry: HistoryEntry) => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    // Store as last translation and navigate to output
    await AsyncStorage.setItem(
      "last_translation",
      JSON.stringify({
        ok: entry.ok,
        output: entry.output,
        diagnostics: entry.diagnostics,
        mappingYaml: entry.mappingYaml || "allocations: {}\n",
        labelsCsv: "",
        stats: {
          inputLines: entry.inputLines,
          outputLines: entry.outputLines,
          warningCount: entry.warningCount,
          manualPortCount: entry.manualPortCount,
        },
      })
    );
    router.push("/output" as any);
  };

  const handleDeleteEntry = (id: string) => {
    Alert.alert("Delete Translation", "Remove this entry from history?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const updated = history.filter((h) => h.id !== id);
          setHistory(updated);
          await AsyncStorage.setItem("translation_history", JSON.stringify(updated));
          if (Platform.OS !== "web") {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          }
        },
      },
    ]);
  };

  const handleClearAll = () => {
    Alert.alert("Clear History", "Delete all translation history?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear All",
        style: "destructive",
        onPress: async () => {
          setHistory([]);
          await AsyncStorage.removeItem("translation_history");
        },
      },
    ]);
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <ScreenContainer className="px-4 pt-2">
      {/* Header */}
      <View className="flex-row items-center justify-between mb-4 mt-2">
        <Text className="text-2xl font-bold text-foreground">History</Text>
        {history.length > 0 && (
          <TouchableOpacity onPress={handleClearAll} activeOpacity={0.7}>
            <Text className="text-error text-sm font-medium">Clear All</Text>
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={history}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TouchableOpacity
            className="bg-surface rounded-xl p-4 mb-3 border border-border"
            onPress={() => handleViewEntry(item)}
            onLongPress={() => handleDeleteEntry(item.id)}
            activeOpacity={0.7}
          >
            <View className="flex-row items-center justify-between mb-2">
              <View className="flex-row items-center gap-2">
                <View className={`px-2 py-0.5 rounded ${item.direction === "ab2mel" ? "bg-primary/20" : "bg-success/20"}`}>
                  <Text className={`text-xs font-bold ${item.direction === "ab2mel" ? "text-primary" : "text-success"}`}>
                    {item.direction === "ab2mel" ? "AB→MEL" : "MEL→AB"}
                  </Text>
                </View>
                <View className={`w-2 h-2 rounded-full ${item.ok ? "bg-success" : "bg-error"}`} />
              </View>
              <Text className="text-xs text-muted">{formatDate(item.timestamp)}</Text>
            </View>
            <Text
              className="text-xs text-muted mb-2"
              numberOfLines={2}
              style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }}
            >
              {item.source}
            </Text>
            <View className="flex-row gap-4">
              <Text className="text-xs text-muted">
                {item.inputLines} → {item.outputLines} lines
              </Text>
              {item.warningCount > 0 && (
                <Text className="text-xs text-warning">{item.warningCount} warnings</Text>
              )}
              {item.manualPortCount > 0 && (
                <Text className="text-xs" style={{ color: "#F97316" }}>
                  {item.manualPortCount} manual
                </Text>
              )}
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View className="items-center py-16">
            <Text className="text-muted text-base mb-2">No translations yet</Text>
            <Text className="text-muted text-sm text-center">
              Translated code will appear here for quick reference.
            </Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: 32 }}
      />
    </ScreenContainer>
  );
}
