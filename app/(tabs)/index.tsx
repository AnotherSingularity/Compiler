import { useState, useCallback } from "react";
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
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { ScreenContainer } from "@/components/screen-container";
import { trpc } from "@/lib/trpc";

type Direction = "ab2mel" | "mel2ab";

export default function TranslateScreen() {
  const [direction, setDirection] = useState<Direction>("ab2mel");
  const [sourceCode, setSourceCode] = useState("");
  const [isTranslating, setIsTranslating] = useState(false);
  const router = useRouter();

  const translateMutation = trpc.translate.useMutation();

  const handleDirectionChange = (dir: Direction) => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    setDirection(dir);
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text) {
        setSourceCode(text);
        if (Platform.OS !== "web") {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
      }
    } catch {
      // Clipboard not available
    }
  };

  const handleTranslate = useCallback(async () => {
    if (!sourceCode.trim()) {
      Alert.alert("No Input", "Please paste or type Structured Text code to translate.");
      return;
    }

    setIsTranslating(true);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    try {
      const result = await translateMutation.mutateAsync({
        direction,
        source: sourceCode,
      });

      // Save to history
      const historyKey = "translation_history";
      const existing = await AsyncStorage.getItem(historyKey);
      const history = existing ? JSON.parse(existing) : [];
      history.unshift({
        id: Date.now().toString(),
        direction,
        timestamp: new Date().toISOString(),
        inputLines: result.stats.inputLines,
        outputLines: result.stats.outputLines,
        warningCount: result.stats.warningCount,
        manualPortCount: result.stats.manualPortCount,
        source: sourceCode.substring(0, 200),
        output: result.output,
        diagnostics: result.diagnostics,
        mappingYaml: result.mappingYaml,
        ok: result.ok,
      });
      // Keep last 50
      if (history.length > 50) history.pop();
      await AsyncStorage.setItem(historyKey, JSON.stringify(history));

      // Navigate to output screen
      await AsyncStorage.setItem("last_translation", JSON.stringify(result));
      router.push("/output" as any);

      if (Platform.OS !== "web") {
        if (result.ok) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
      }
    } catch (error: any) {
      Alert.alert("Translation Error", error?.message || "Failed to translate. Please try again.");
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } finally {
      setIsTranslating(false);
    }
  }, [sourceCode, direction, translateMutation, router]);

  return (
    <ScreenContainer className="px-4 pt-2">
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View className="items-center mb-4 mt-2">
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
            <Text
              className={`font-semibold text-base ${direction === "ab2mel" ? "text-background" : "text-muted"}`}
            >
              AB → MEL
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            className={`flex-1 py-3 rounded-lg items-center ${direction === "mel2ab" ? "bg-primary" : ""}`}
            onPress={() => handleDirectionChange("mel2ab")}
            activeOpacity={0.7}
          >
            <Text
              className={`font-semibold text-base ${direction === "mel2ab" ? "text-background" : "text-muted"}`}
            >
              MEL → AB
            </Text>
          </TouchableOpacity>
        </View>

        {/* Direction Info */}
        <View className="bg-surface rounded-xl p-3 mb-4 border border-border">
          <Text className="text-xs text-muted">
            {direction === "ab2mel"
              ? "Paste Allen-Bradley Studio 5000 Structured Text below. Output will be GX Works2 compatible."
              : "Paste Mitsubishi GX Works2 Structured Text below. Output will be Studio 5000 compatible."}
          </Text>
        </View>

        {/* Source Code Input */}
        <View className="mb-4">
          <View className="flex-row justify-between items-center mb-2">
            <Text className="text-sm font-medium text-foreground">Source Code</Text>
            <TouchableOpacity
              onPress={handlePasteFromClipboard}
              className="bg-surface px-3 py-1.5 rounded-lg border border-border"
              activeOpacity={0.7}
            >
              <Text className="text-xs text-primary font-medium">Paste</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            className="bg-surface border border-border rounded-xl p-4 text-foreground min-h-[240px]"
            style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 13, lineHeight: 20 }}
            multiline
            textAlignVertical="top"
            placeholder={
              direction === "ab2mel"
                ? "// Paste AB Structured Text here\nIF RunMode THEN\n  Speed := SetPoint * 0.95;\n  TON(RunTimer);\nEND_IF;"
                : "// Paste MEL Structured Text here\nIF M100 THEN\n  D1000 := D1002 * 95 / 100;\n  RunTimer(IN := M100, PT := T#5S);\nEND_IF;"
            }
            placeholderTextColor="#64748B"
            value={sourceCode}
            onChangeText={setSourceCode}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
          />
        </View>

        {/* Translate Button */}
        <TouchableOpacity
          className={`w-full py-4 rounded-xl items-center justify-center ${isTranslating ? "bg-primary/70" : "bg-primary"}`}
          onPress={handleTranslate}
          disabled={isTranslating}
          activeOpacity={0.8}
        >
          {isTranslating ? (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator color="white" size="small" />
              <Text className="text-background font-bold text-base">Translating...</Text>
            </View>
          ) : (
            <Text className="text-background font-bold text-base">Translate</Text>
          )}
        </TouchableOpacity>

        {/* Quick Info */}
        <View className="mt-4 bg-surface rounded-xl p-4 border border-border">
          <Text className="text-xs font-semibold text-foreground mb-2">V1 Supported Constructs</Text>
          <Text className="text-xs text-muted leading-5">
            IF/ELSIF/ELSE, CASE, FOR, WHILE, REPEAT, TON/TOF/RTO, CTU/CTD/CTUD, UDT/STRUCT, Arrays, AOI/FB, Type conversions, Comments
          </Text>
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}
