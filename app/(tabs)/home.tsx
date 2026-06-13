import { Text, View, TouchableOpacity, Platform, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";

import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";

const C = {
  bgBase: "#0a0a0a",
  rule: "#2a2620",
  textPrimary: "#e8e2d0",
  textMuted: "#9a9382",
  gold: "#c9a961",
  goldDim: "#8a7440",
};

const tools = [
  { id: "compiler", title: "ST Compiler", description: "Translate Structured Text between Allen-Bradley and Mitsubishi", route: "/(tabs)", status: "active" },
  { id: "validator", title: "Code Validator", description: "AI-assisted semantic validation of translated output", route: null, status: "coming_soon" },
];

export default function HomeScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();

  const handleTileTap = (tool: typeof tools[0]) => {
    if (tool.status !== "active" || !tool.route) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(tool.route as any);
  };

  return (
    <ScreenContainer containerClassName="bg-background">
      <View style={{ paddingHorizontal: 20, flex: 1 }}>
        {/* Header */}
        <View style={s.header}>
          <Text style={s.wordmark}>ST Compiler</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={s.userEmail}>{user?.email || ""}</Text>
            <TouchableOpacity onPress={logout}>
              <Text style={s.signOut}>Sign out</Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={s.hairline} />

        {/* Tagline */}
        <View style={{ alignItems: "center", marginTop: 32, marginBottom: 32 }}>
          <Text style={s.tagline}>Allen-Bradley ↔ Mitsubishi</Text>
        </View>

        {/* Tool Tiles */}
        {tools.map((tool) => (
          <TouchableOpacity
            key={tool.id}
            style={[s.tile, tool.status === "coming_soon" && s.tileMuted]}
            onPress={() => handleTileTap(tool)}
            activeOpacity={tool.status === "active" ? 0.7 : 1}
            disabled={tool.status !== "active"}
          >
            <View style={{ flex: 1 }}>
              <Text style={[s.tileTitle, tool.status === "coming_soon" && s.tileTitleMuted]}>
                {tool.title}
              </Text>
              <Text style={s.tileDesc}>{tool.description}</Text>
            </View>
            {tool.status === "active" && <Text style={s.tileArrow}>→</Text>}
          </TouchableOpacity>
        ))}
      </View>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 16 },
  wordmark: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 20, fontWeight: "500", color: C.gold },
  userEmail: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 12, color: C.textMuted },
  signOut: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 13, fontStyle: "italic", color: C.gold },
  hairline: { height: 1, backgroundColor: C.rule },
  tagline: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 16, fontStyle: "italic", color: C.textMuted },
  tile: { borderWidth: 1, borderColor: C.gold, borderRadius: 2, padding: 20, marginBottom: 16, flexDirection: "row", alignItems: "center" },
  tileMuted: { borderColor: C.rule },
  tileTitle: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 18, fontWeight: "500", color: C.gold, marginBottom: 4 },
  tileTitleMuted: { color: C.textMuted },
  tileDesc: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 14, fontStyle: "italic", color: C.textMuted, lineHeight: 20 },
  tileArrow: { fontFamily: Platform.OS === "ios" ? "Georgia" : "serif", fontSize: 24, color: C.gold, marginLeft: 16 },
});
