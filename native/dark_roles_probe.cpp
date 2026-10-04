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

    // Alternate character sets may contain rank-9 roles. The assassin's
    // legal-action generator includes roles from char_deck; execution must
    // accept the same rank instead of applying the base-set 1..8 limit.
    NativeGameState assassin_rank_nine;
    assassin_rank_nine.phase = NativePhase::Action;
    assassin_rank_nine.active_player = 0;
    assassin_rank_nine.pending_kind = "assassin";
    assassin_rank_nine.char_deck = {"assassin", "tax_collector"};
    assassin_rank_nine.players = {player("assassin", "assassin", 0),
                                 player("tax", "tax_collector", 0)};
    const auto assassin_targets = game.legal_actions(assassin_rank_nine, 0);
    const auto rank_nine = std::find_if(assassin_targets.begin(), assassin_targets.end(),
      [](const NativeSearchAction& action) { return action.num == 9; });
    require(rank_nine != assassin_targets.end(), "rank-9 role should be a legal assassin target");
    require(game.apply(assassin_rank_nine, 0, *rank_nine) &&
            assassin_rank_nine.assassinated == 9,
      "assassin should be able to target an available rank-9 role");

    // Quarry permits one duplicate district name. Diplomat action generation
    // and execution must both honor that limit during a city swap.
    NativeGameState diplomat_quarry;
    diplomat_quarry.phase = NativePhase::Action;
    diplomat_quarry.active_player = 0;
    diplomat_quarry.pending_kind = "diplomat_theirs";
    diplomat_quarry.pending_uid = "selected";
    diplomat_quarry.players = {player("diplomat", "diplomat", 3),
                               player("target", "king", 0)};
    diplomat_quarry.players[0].city = {
      {{"q", "purple", 4, "Quarry"}, "Quarry", "quarry"},
      {{"existing-market", "green", 2, "Market"}, "Market"},
      {{"selected", "blue", 2, "Chapel"}, "Chapel"},
    };
    diplomat_quarry.players[1].city = {
      {{"target-market", "green", 3, "Market"}, "Market"},
    };
    const auto diplomat_targets = game.legal_actions(diplomat_quarry, 0);
    const auto duplicate_market = std::find_if(diplomat_targets.begin(), diplomat_targets.end(),
      [](const NativeSearchAction& action) {
        return action.uid == "target-market" && action.target == "target";
      });
    require(duplicate_market != diplomat_targets.end(),
      "diplomat should be offered the extra same-name district allowed by Quarry");
    require(game.apply(diplomat_quarry, 0, *duplicate_market) &&
            std::count_if(diplomat_quarry.players[0].city.begin(), diplomat_quarry.players[0].city.end(),
              [](const NativeDistrict& district) { return district.name == "Market"; }) == 2,
      "diplomat execution should allow a Quarry-permitted duplicate district");

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
    NativeGameState empty_wizard;
    empty_wizard.phase = NativePhase::Action; empty_wizard.active_player = 0;
    empty_wizard.resources_taken = true;
    empty_wizard.players = {player("wizard", "wizard", 5), player("empty", "king", 2)};
    empty_wizard.players[0].hand = {{"own", "green", 1, "Tavern"}};
    require(empty_wizard.start_ability() && empty_wizard.pending_kind.empty() && empty_wizard.ability_used,
      "wizard with only own-hand cards should complete an effect with no eligible targets");
    const auto empty_wizard_main = game.legal_actions(empty_wizard, 0);
    find_action(empty_wizard_main, ActionType::EndTurn);
    // Existing snapshots may already be stuck at target selection.
    empty_wizard.pending_kind = "wizard_target"; empty_wizard.ability_used = false;
    auto empty_wizard_targets = game.legal_actions(empty_wizard, 0);
    require(empty_wizard_targets.size() == 1 && empty_wizard_targets[0].type == ActionType::AbilitySkip,
      "wizard empty target list should expose skip instead of zero legal actions");
    NativeSearchAction empty_target; empty_target.type = ActionType::WizardTarget; empty_target.target = "empty";
    require(!game.apply(empty_wizard, 0, empty_target) && empty_wizard.pending_kind == "wizard_target",
      "wizard must reject an empty-hand target without changing phase");
    require(game.apply(empty_wizard, 0, empty_wizard_targets[0]) && empty_wizard.pending_kind.empty() && empty_wizard.ability_used,
      "wizard skip should release a pending selection with no target");
    NativeGameState wizard;
    wizard.phase = NativePhase::Action; wizard.active_player = 0; wizard.pending_kind = "wizard_target";
    wizard.players = {player("wizard", "wizard", 5), player("source", "king", 2)};
    wizard.players[1].hand = {{"w1", "purple", 2, "Haunted Tower"}};
    NativeSearchAction wizard_target; wizard_target.type = ActionType::WizardTarget; wizard_target.target = "source";
    require(game.apply(wizard, 0, wizard_target), "wizard target");
    NativeSearchAction wizard_card; wizard_card.type = ActionType::WizardCard; wizard_card.uid = "w1";
    require(game.apply(wizard, 0, wizard_card), "wizard card");
    auto wizard_choices = game.legal_actions(wizard, 0);
    require(wizard_choices.size() == 3 && wizard_choices[0].type == ActionType::WizardTake &&
            wizard_choices[1].type == ActionType::WizardBuild &&
            wizard_choices[2].type == ActionType::PendingBack,
      "wizard choice actions should match Python, including returning to choose another card");
    NativeSearchAction wizard_back; wizard_back.type = ActionType::PendingBack;
    require(game.apply(wizard, 0, wizard_back) && wizard.pending_kind == "wizard_card" &&
            wizard.pending_cards.size() == 1 && wizard.pending_cards.front().uid == "w1",
      "wizard back should restore target hand for card selection");
    require(game.apply(wizard, 0, wizard_card), "wizard reselect card after backing");
    NativeSearchAction wizard_build; wizard_build.type = ActionType::WizardBuild;
    require(game.apply(wizard, 0, wizard_build), "wizard immediate build");
    require(wizard.players[0].city.size() == 1 && wizard.players[1].hand.empty() && wizard.players[0].gold == 3 && wizard.builds == 0,
      "wizard build should not consume normal build count");

    NativeGameState monk;
    monk.phase = NativePhase::Action; monk.active_player = 0; monk.pending_kind = "monk_declare";
    monk.players = {player("monk", "monk", 2)};
    monk.players[0].city = {{{"blue", "blue", 1, "Temple"}, "Temple"},
                            {{"purple", "purple", 2, "Ghost Town"}, "Ghost Town", "anyColorIncome"}};
    auto monk_actions = game.legal_actions(monk, 0);
    require(monk_actions.size() == 3 && monk_actions[0].gold == 0 && monk_actions[0].cards == 2 &&
            monk_actions[1].gold == 1 && monk_actions[1].cards == 1 &&
            monk_actions[2].gold == 2 && monk_actions[2].cards == 0,
      "monk actions should carry explicit resource fields and count any-color income buildings");
    require(game.apply(monk, 0, monk_actions[2]) && monk.players[0].gold == 4 &&
            monk.pending_kind.empty(),
      "monk execution should use the same blue/any-color building count as legal actions");

    NativeGameState noble;
    noble.phase = NativePhase::Action; noble.active_player = 0; noble.resources_taken = true;
    noble.players = {player("noble", "noble", 2)};
    const auto noble_actions = game.legal_actions(noble, 0);
    require(std::none_of(noble_actions.begin(), noble_actions.end(), [](const NativeSearchAction& action) {
      return action.type == ActionType::Income;
    }), "noble must not expose income when the Python catalog marks income as null");

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
    auto subsidy = std::find_if(build_options.begin(), build_options.end(), [](const NativeSearchAction& a) {
      return a.type == ActionType::Build && a.uid == "house" && a.target.empty();
    });
    require(subsidy != build_options.end() && bishop_game.apply(bishop, 0, *subsidy), "bishop selects building");
    auto payer_options = bishop_game.legal_actions(bishop, 0);
    auto payer = std::find_if(payer_options.begin(), payer_options.end(), [](const NativeSearchAction& a) {
      return a.type == ActionType::ChoosePlayer && a.target == "payer";
    });
    require(payer != payer_options.end() && bishop_game.apply(bishop, 0, *payer), "bishop selects payer");
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
