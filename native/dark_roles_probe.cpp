#include <algorithm>
#include <iostream>
#include <stdexcept>

#include "game_adapter.hpp"

using namespace citadels::native;

namespace {
void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
NativePlayer player(const char* id, const char* role, int gold) {
  NativePlayer p; p.id = id; p.role_id = role; p.gold = gold; p.role_ids.push_back(role); return p;
}
NativeSearchAction number_action(ActionType type, int n) {
  NativeSearchAction a; a.type = type; a.num = n; a.has_num = true; return a;
}
const NativeSearchAction& find_action(const std::vector<NativeSearchAction>& actions, ActionType type, int n = -999) {
  const auto it = std::find_if(actions.begin(), actions.end(), [&](const NativeSearchAction& a) {
    return a.type == type && (n == -999 || a.num == n);
  });
  if (it == actions.end()) throw std::runtime_error("expected legal action not found");
  return *it;
}
}

int main() {
  try {
    NativeGameAdapter game;

    // Magistrate: declare one real + two false warrants; intercept and seize a build.
    NativeGameState s;
    s.phase = NativePhase::Action; s.active_player = 0; s.resources_taken = true;
    s.char_deck = {"magistrate", "spy", "wizard", "king", "abbot", "tax_collector"};
    s.players = {player("p0", "magistrate", 2), player("p1", "king", 8), player("p2", "tax_collector", 2)};
    s.players[1].hand.push_back({"build-1", "red", 3, "Watchtower"});
    require(s.start_ability(), "magistrate ability");
    require(game.apply(s, 0, number_action(ActionType::MagistrateSigned, 4)), "signed warrant");
    require(game.apply(s, 0, number_action(ActionType::MagistrateChar, 5)), "first decoy");
    require(game.apply(s, 0, number_action(ActionType::MagistrateChar, 9)), "second decoy");
    require(s.magistrate_signed == 4 && s.magistrate_nums.size() == 3, "warrant assignment state");
    s.active_player = 1;
    NativeSearchAction build; build.type = ActionType::Build; build.uid = "build-1"; build.name = "Watchtower";
    require(game.apply(s, 1, build) && s.reaction_kind == "magistrate", "signed warrant reaction");
    NativeSearchAction seize; seize.type = ActionType::Reaction; seize.name = "use";
    require(game.next_player(s) == 0 && game.apply(s, 0, seize), "magistrate seize response");
    require(s.players[0].city.size() == 1 && s.players[1].city.empty() && s.players[1].gold == 8 && s.tax_collector_gold == 1,
      "confiscated building, refunded build cost, and tax charged to magistrate");

    // Spy: investigate a color, collect matching-count cards and capped gold.
    NativeGameState spy;
    spy.phase = NativePhase::Action; spy.active_player = 0; spy.pending_kind = "spy_target";
    spy.players = {player("spy", "spy", 1), player("victim", "king", 3)};
    spy.players[1].hand = {{"h1", "blue", 2, "Chapel"}, {"h2", "blue", 3, "Temple"}, {"h3", "red", 2, "Watch"}};
    spy.deck = DeckMachine({{"draw1", "purple", 4, "Observatory"}, {"draw2", "green", 2, "Market"}});
    NativeSearchAction target; target.type = ActionType::SpyTarget; target.target = "victim";
    require(game.apply(spy, 0, target), "spy target");
    NativeSearchAction color; color.type = ActionType::SpyColor; color.color = "blue";
    require(game.apply(spy, 0, color), "spy color");
    require(spy.players[0].gold == 3 && spy.players[1].gold == 1 && spy.players[0].hand.size() == 2,
      "spy resource resolution");

    // Wizard: inspect an opponent hand and immediately build the chosen card.
    NativeGameState wizard;
    wizard.phase = NativePhase::Action; wizard.active_player = 0; wizard.pending_kind = "wizard_target";
    wizard.players = {player("wizard", "wizard", 5), player("source", "king", 2)};
    wizard.players[1].hand = {{"w1", "purple", 2, "Haunted Tower"}};
    NativeSearchAction wizard_target; wizard_target.type = ActionType::WizardTarget; wizard_target.target = "source";
    require(game.apply(wizard, 0, wizard_target), "wizard target");
    NativeSearchAction wizard_card; wizard_card.type = ActionType::WizardCard; wizard_card.uid = "w1";
    require(game.apply(wizard, 0, wizard_card), "wizard card");
    NativeSearchAction wizard_build; wizard_build.type = ActionType::WizardBuild;
    require(game.apply(wizard, 0, wizard_build), "wizard immediate build");
    require(wizard.players[0].city.size() == 1 && wizard.players[1].hand.empty() && wizard.players[0].gold == 3 && wizard.builds == 0,
      "wizard build should not consume normal build count");

    // Abbot: religious buildings grant gold; active abbot protects the city from rank-8 roles.
    NativeGameState abbot;
    abbot.phase = NativePhase::Action; abbot.active_player = 0; abbot.income_taken = false;
    abbot.players = {player("abbot", "abbot", 2), player("rich", "king", 8), player("other", "merchant", 4)};
    abbot.players[0].role_ids = {"abbot"};
    abbot.players[0].city = {{{"b1", "blue", 2, "Chapel"}, "Chapel"}, {{"b2", "blue", 3, "Temple"}, "Temple"}};
    require(abbot.income(), "abbot religious income");
    require(abbot.players[0].gold == 4 && abbot.players[1].gold == 8 && abbot.players[0].hand.empty(),
      "abbot gains one coin per religious district only");
    NativeGameState abbot_guard;
    abbot_guard.active_player = 0; abbot_guard.players = {player("w", "warlord", 8), player("a", "abbot", 2)};
    abbot_guard.players[0].role_ids = {"warlord"}; abbot_guard.players[1].role_ids = {"abbot"};
    abbot_guard.players[1].played = {"abbot"};   // 保护看的是「已打出」（公开信息），不是手里握着
    abbot_guard.players[1].city = {{{"guarded", "blue", 2, "Chapel"}, "Chapel"}};
    require(!abbot_guard.warlord_destroy("a", "guarded"), "active abbot rank-8 protection");
    abbot_guard.assassinated = 5;
    require(abbot_guard.warlord_destroy("a", "guarded"), "assassinated abbot loses protection");

    // Bishop: draw per religious district and may use one player to subsidize a build.
    NativeGameState bishop;
    bishop.phase = NativePhase::Action; bishop.active_player = 0; bishop.resources_taken = true;
    bishop.players = {player("bishop", "bishop", 1), player("payer", "king", 3)};
    bishop.players[0].role_ids = {"bishop"};
    bishop.players[0].city = {{{"bb1", "blue", 2, "Chapel"}, "Chapel"}, {{"bb2", "blue", 2, "Temple"}, "Temple"}};
    bishop.players[0].hand = {{"house", "red", 3, "Tower"}, {"pay1", "blue", 2, "Chapel"}, {"pay2", "green", 2, "Market"}};
    bishop.deck = DeckMachine({{"draw1", "green", 2, "Market"}, {"draw2", "red", 2, "Keep"}});
    require(bishop.income() && bishop.players[0].hand.size() == 5, "bishop draws per religious district");
    bishop.income_taken = true;
    bishop.players[0].hand = {{"house", "red", 3, "Tower"}, {"pay1", "blue", 2, "Chapel"}, {"pay2", "green", 2, "Market"}};
    NativeGameAdapter bishop_game;
    auto build_options = bishop_game.legal_actions(bishop, 0);
    auto subsidy = std::find_if(build_options.begin(), build_options.end(), [](const NativeSearchAction& a) { return a.type == ActionType::Build && a.target == "payer"; });
    require(subsidy != build_options.end() && bishop_game.apply(bishop, 0, *subsidy), "bishop selects payer for build");
    auto repay_options = bishop_game.legal_actions(bishop, 0);
    require(repay_options.size() == 1 && repay_options.front().type == ActionType::ChooseCards, "bishop selects exact repayment cards");
    require(bishop_game.apply(bishop, 0, repay_options.front()), "bishop repays subsidy with hand cards");
    require(bishop.players[0].city.size() == 3 && bishop.players[0].city.back().card.uid == "house",
      "bishop subsidized building enters city");
    require(bishop.players[0].gold == 0, "bishop pays own available gold");
    require(bishop.players[1].gold == 1, "bishop payer covers only the shortfall");
    require(bishop.players[1].hand.size() == 2, "bishop payer receives one card per subsidized coin");

    // Tax collector: every eligible build adds one coin; its role ability claims the bank.
    NativeGameState tax;
    tax.phase = NativePhase::Action; tax.active_player = 1; tax.resources_taken = true;
    tax.char_deck = {"king", "tax_collector"};
    tax.players = {player("collector", "tax_collector", 2), player("builder", "king", 5)};
    tax.players[1].hand.push_back({"t1", "green", 2, "Market"});
    require(tax.build("t1", "Market"), "taxable build");
    require(tax.players[1].gold == 2 && tax.tax_collector_gold == 1, "tax charged on build");
    tax.active_player = 0; tax.players[0].role_id = "tax_collector"; tax.pending_kind = "tax_collect";
    NativeSearchAction collect; collect.type = ActionType::TaxCollect;
    require(game.apply(tax, 0, collect), "collect tax");
    require(tax.players[0].gold == 3 && tax.tax_collector_gold == 0, "tax bank claimed");

    // Blackmailer: pause the marked role before resources; refuse, then resolve at owner decision.
    NativeGameState black;
    black.phase = NativePhase::Action; black.active_player = 0; black.turn_phase = "main";
    black.players = {player("blackmailer", "blackmailer", 2), player("marked", "wizard", 6)};
    black.blackmailer_nums = {3}; black.blackmailer_signed = 3; black.blackmailer_player = 0;
    black.call_queue = {{"wizard", 3, 1}}; black.call_index = -1;
    require(black.end_turn() && black.pending_kind == "blackmailer_threat" && game.next_player(black) == 1,
      "blackmailer blocks marked turn before resources");
    NativeSearchAction refuse; refuse.type = ActionType::BlackmailerRefuse;
    require(game.apply(black, 1, refuse) && game.next_player(black) == 0, "blackmailer refusal response");
    NativeSearchAction reveal; reveal.type = ActionType::Reaction; reveal.name = "use";
    require(game.apply(black, 0, reveal), "blackmailer reveals real token");
    require(black.players[0].gold == 8 && black.players[1].gold == 0 && black.pending_kind.empty(),
      "real threat takes all gold and unfreezes target");

    std::cout << "dark-role-native-rules-ok\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
