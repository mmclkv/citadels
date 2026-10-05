#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

#include "game_adapter.hpp"

namespace citadels::native {

// Heuristic policy. It only ranks actions already
// produced by NativeGameAdapter, so it cannot invent an action the rules reject.
class NativeNpcPolicy {
 public:
  static int choose(const NativeGameState& state, int player,
                    const std::vector<NativeSearchAction>& actions,
                    uint32_t seed = 1) {
    if (player < 0 || player >= static_cast<int>(state.players.size()) || actions.empty()) return -1;
    const auto& p = state.players[player];
    uint32_t random = seed ? seed : 1;
    int best = 0;
    double best_score = -std::numeric_limits<double>::infinity();
    for (size_t i = 0; i < actions.size(); ++i) {
      double score = score_action(state, player, actions[i], random);
      if (p.bot_level == "hard" && state.phase == NativePhase::Action &&
          state.active_player == player && state.pending_kind.empty() && state.reaction_kind.empty()) {
        double planned = 0;
        if (plan_action(state, player, actions[i], planned)) score = planned;
      }
      score -= i * 1e-7;
      if (score > best_score) { best_score = score; best = static_cast<int>(i); }
    }
    return best;
  }

 private:
  static uint32_t next_random(uint32_t& state) {
    state ^= state << 13; state ^= state >> 17; state ^= state << 5; return state;
  }
  static double noise(uint32_t& state, double scale) {
    return (static_cast<double>(next_random(state) & 0xffff) / 65535.0 - 0.5) * scale;
  }
  static int color_count(const NativePlayer& p, const std::string& color) {
    if (color.empty()) return 0;
    return static_cast<int>(std::count_if(p.city.begin(), p.city.end(), [&](const auto& d) {
      return d.card.color == color || d.effect == "anyColorIncome";
    }));
  }
  static const DistrictCard* card_by_uid(const std::vector<DistrictCard>& cards, const std::string& uid) {
    const auto it = std::find_if(cards.begin(), cards.end(), [&](const auto& c) { return c.uid == uid; });
    return it == cards.end() ? nullptr : &*it;
  }
  static double card_value(const NativeGameState& s, const NativePlayer& p, const DistrictCard& c) {
    double value = c.cost * 1.05;
    const bool color_exists = std::any_of(p.city.begin(), p.city.end(), [&](const auto& d) { return d.card.color == c.color; });
    if (!color_exists) value += 2.2;
    if (color_exists) value += std::min(1.2, color_count(p, c.color) * 0.25);
    if (c.color == "purple") value += 1.2;
    if (c.purple_effect == "scoreAs") value += 0.8;
    else if (c.purple_effect == "keepBoth" || c.purple_effect == "draw3keep1" ||
             c.purple_effect == "smithy" || c.purple_effect == "lab" || c.purple_effect == "immune") value += 1.0;
    else if (c.purple_effect == "anyColorIncome") value += color_count(p, "blue") == 0 ? 1.8 : 0.8;
    else if (c.purple_effect == "extraBuild") value += 1.8;
    const int left = std::max(0, s.end_districts - static_cast<int>(p.city.size()));
    if (left <= 2) value += c.cost * 0.35;
    if (left == 0) value -= 8;
    return value;
  }
  static double hand_value(const NativeGameState& s, const NativePlayer& p, const DistrictCard& c) {
    const int same = static_cast<int>(std::count_if(p.city.begin(), p.city.end(),
      [&](const auto& d) { return d.name == c.name; }));
    const int quarry = static_cast<int>(std::count_if(p.city.begin(), p.city.end(),
      [](const auto& d) { return d.effect == "quarry"; }));
    if (same >= 1 + quarry) return 0.15;
    return std::max(0.2, card_value(s, p, c) * 0.55 - std::max(0, c.cost - p.gold - 2) * 0.35);
  }
  static double money_value(const NativePlayer& p) { return p.gold < 3 ? 1.5 : p.gold < 6 ? 0.9 : 0.45; }
  static double draw_value(const NativeGameState& s, const NativePlayer& p) {
    return s.deck.deck_count() + s.deck.discard_count() == 0 ? 0.0
      : p.hand.size() < 2 ? 3.4 : p.hand.size() < 5 ? 2.5 : 1.2;
  }
  static int leader(const NativeGameState& s) {
    int best = 0;
    double score = -1;
    for (size_t i = 0; i < s.players.size(); ++i) {
      const double current = native_player_score(s, static_cast<int>(i));
      if (current > score) { score = current; best = static_cast<int>(i); }
    }
    return best;
  }
  static bool should_use_ability(const NativeGameState& s, int index) {
    const auto& p = s.players[index];
    const auto& role = p.role_id;
    if (role == "assassin" || role == "thief" || role == "witch" || role == "magician" ||
        role == "magistrate" || role == "spy" || role == "blackmailer" || role == "wizard" ||
        role == "tax_collector" || role == "emperor" || role == "scholar" || role == "prophet") return true;
    if (role == "warlord") return p.gold >= 1;
    if (role == "marshal") return p.gold >= 1;
    if (role == "diplomat") return p.gold >= 1 &&
      std::any_of(p.city.begin(), p.city.end(), [](const auto& d) { return !d.fortress && d.effect != "scoreAs"; });
    if (role == "artist") return p.gold >= 3 && !p.city.empty();
    if (role == "navigator") return !s.bonus_done;
    return false;
  }
  static std::string role_income(const std::string& role) {
    if (role == "king" || role == "noble" || role == "emperor") return "yellow";
    if (role == "bishop" || role == "abbot" || role == "monk") return "blue";
    if (role == "merchant" || role == "alchemist" || role == "businessman") return "green";
    if (role == "warlord" || role == "diplomat" || role == "marshal") return "red";
    return {};
  }
  static double role_value(const NativeGameState& s, int index, const std::string& role) {
    const auto& p = s.players[index];
    const int hand_cost = [&] { int n = 0; for (const auto& c : p.hand) n += c.cost; return n; }();
    const int behind = static_cast<int>(s.players[leader(s)].city.size()) - static_cast<int>(p.city.size());
    double v = 0;
    if (role == "architect") v += 1.2;
    else if (role == "merchant") v += 0.6;
    else if (role == "bishop") v += 0.8 + color_count(p, "blue") * 0.2;
    else if (role == "warlord") v += color_count(p, "red") * 0.3 + (behind >= 2 ? 2 : 0) + (p.gold >= 4 ? 0.8 : 0);
    else if (role == "diplomat" || role == "marshal") v += (behind >= 2 ? (role == "marshal" ? 1.4 : 1.2) : 0) + color_count(p, "red") * 0.3;
    else if (role == "thief") { int wealth = 0; for (size_t i=0;i<s.players.size();++i) if (static_cast<int>(i)!=index) wealth=std::max(wealth,s.players[i].gold); v += std::min(3,wealth) * 0.45; }
    else if (role == "assassin") v += 1;
    else if (role == "magician") v += p.hand.size() <= 1 ? 1.6 : 0.2;
    else if (role == "king") v += 0.7 + (!p.has_crown ? 0.5 : 0);
    else if (role == "noble") v += color_count(p, "yellow") * 0.9;
    else if (role == "navigator" || role == "scholar" || role == "prophet") v += role == "scholar" ? 1.2 : 0.9;
    else if (role == "alchemist") v += p.gold >= 6 ? 1.5 : 0.1;
    else if (role == "businessman") v += color_count(p, "green") * 0.3;
    else if (role == "monk") v += color_count(p, "blue") * 0.8;
    else if (role == "artist") v += p.gold >= 4 ? 1.4 : 0;
    else if (role == "queen") {
      const int n = static_cast<int>(s.players.size());
      for (int neighbor : {(index + n - 1) % n, (index + 1) % n})
        if (s.players[neighbor].has_crown) v += 2.2;
    }
    else if (role == "witch") v += 0.9;
    else if (role == "emperor") v += 0.4;
    else if (role == "tax_collector") v += s.tax_collector_gold * 0.65 + s.players.size() * 0.2;
    else if (role == "spy") { for (const auto& t : s.players) if (t.id != p.id) v = std::max(v, t.hand.size() * 0.2 + std::min(t.gold, 3) * 0.2); }
    else if (role == "blackmailer") v += 0.8;
    else if (role == "magistrate") v += 1.2;
    else if (role == "wizard") v += p.hand.empty() ? 1.8 : 0.8;
    v += color_count(p, role_income(role)) * 0.35;
    if (p.hand.size() <= 1 && (role == "scholar" || role == "architect")) v += 2;
    if (p.gold >= 5 && hand_cost >= 5 && (role == "architect" || role == "scholar")) v += 1.2;
    if (static_cast<int>(p.city.size()) >= s.end_districts - 2 &&
        (role == "architect" || role == "prophet" || role == "scholar")) v += 1.4;
    return v;
  }
  static double position_value(const NativeGameState& s, int index) {
    const auto& p = s.players[index];
    double value = native_player_score(s,index) + p.city.size() * 1.8 + std::min(p.gold,12) * 0.55;
    for (const auto& c : p.hand) value += hand_value(s,p,c) * 0.35;
    if (s.first_to_finish >= 0) {
      double rival = 0;
      for (size_t i=0;i<s.players.size();++i) if (static_cast<int>(i)!=index)
        rival = std::max(rival, static_cast<double>(native_player_score(s,static_cast<int>(i))));
      const double margin = native_player_score(s,index) - rival;
      // Finishing while behind is not intrinsically good. More own builds in this
      // same turn may still recover the lead; planning does not stop at the threshold.
      value += margin >= 0 ? 35 + margin : -35 + margin * 2;
    }
    return value;
  }
  static bool planned_step(NativeGameState& s, int index, const NativeSearchAction& a, double& expected) {
    const auto& p = s.players[index];
    const auto before_role = p.role_id;
    const bool bonus = !s.bonus_done && !s.ability_used && before_role == "architect";
    const size_t available = s.deck.deck_count() + s.deck.discard_count();
    if (a.type == ActionType::EndTurn) return true;
    if (a.type == ActionType::TakeCards || a.type == ActionType::Smithy ||
        (a.type == ActionType::Income && before_role == "bishop")) {
      const bool library = std::any_of(p.city.begin(),p.city.end(),[](const auto& d){return d.effect=="keepBoth";});
      int keep = a.type == ActionType::Smithy ? 3 : a.type == ActionType::Income ? s.blue_districts(index) : library ? 2 : 1;
      const size_t card_budget = (a.type==ActionType::TakeCards && bonus)
        ? std::min<size_t>(available,keep+2) : std::min<size_t>(available,keep);
      expected += card_budget * draw_value(s,p) * 0.35;
    } else if (a.type != ActionType::TakeGold && a.type != ActionType::Build &&
               a.type != ActionType::Income && a.type != ActionType::Lab && a.type != ActionType::Museum) return false;
    if (a.type == ActionType::TakeGold && bonus)
      expected += std::min<size_t>(2,available) * draw_value(s,p) * 0.35;
    // Retain only public pile COUNTS for future expected draws. Actual cards are
    // removed from the simulated deck so rules cannot reveal their identities.
    size_t drawn = 0;
    if (a.type == ActionType::TakeCards) drawn = std::any_of(p.city.begin(),p.city.end(),
      [](const auto& d){return d.effect=="draw3keep1";}) && !std::any_of(p.city.begin(),p.city.end(),
      [](const auto& d){return d.effect=="keepBoth";}) ? 3 : 2;
    if (a.type == ActionType::Smithy) drawn = 3;
    if (a.type == ActionType::Income && before_role == "bishop") drawn = s.blue_districts(index);
    if ((a.type == ActionType::TakeGold || a.type == ActionType::TakeCards) && bonus) drawn += 2;
    std::vector<DistrictCard> anonymous(available - std::min(available,drawn));
    s.deck.load({},{});
    NativeGameAdapter rules;
    if (!rules.apply(s,index,a)) return false;
    s.deck.load(std::move(anonymous),{});
    // Architect/navigator/scholar pending draws are treated as unknown outcomes;
    // stop the deterministic horizon there rather than inventing exact new cards.
    return true;
  }
  static double plan_tail(const NativeGameState& s, int index, double expected, int depth, int& budget) {
    double best = position_value(s,index) + expected;
    if (!depth || budget <= 0 || !s.pending_kind.empty() || !s.reaction_kind.empty()) return best;
    NativeGameAdapter rules;
    auto actions = rules.legal_actions(s,index);
    uint32_t rng = 1;
    std::stable_sort(actions.begin(),actions.end(),[&](const auto& a,const auto& b){
      uint32_t ra=rng,rb=rng; return score_action(s,index,a,ra)>score_action(s,index,b,rb); });
    int branches = 0;
    for (const auto& a : actions) {
      if (a.type == ActionType::EndTurn) continue;
      auto next = s; double next_expected = expected;
      if (!planned_step(next,index,a,next_expected)) continue;
      --budget;
      best = std::max(best,plan_tail(next,index,next_expected,depth-1,budget));
      if (++branches == 6 || budget <= 0) break;
    }
    return best;
  }
  static bool plan_action(const NativeGameState& s, int index, const NativeSearchAction& a, double& result) {
    auto projected = s;
    // No opponent cards, unrevealed role assignments, or secret warrant identity
    // enter the deterministic planner. Public cities/gold/counts remain available.
    for (size_t i=0;i<projected.players.size();++i) if (static_cast<int>(i)!=index) {
      auto& p = projected.players[i]; p.hand_count=static_cast<int>(p.hand.size()); p.hand.clear();
      p.role_id.clear(); p.role_ids.clear();
    }
    projected.magistrate_signed = -1;
    projected.blackmailer_signed = -1;
    double expected=0;
    const double baseline = position_value(projected,index);
    if (!planned_step(projected,index,a,expected)) return false;
    int budget = 64;
    const double outcome = a.type == ActionType::EndTurn ? position_value(projected,index)
      : plan_tail(projected,index,expected,5,budget);
    result = 100 + 12 * (outcome - baseline);
    // Public warrant targets are risky even though their true identity is hidden.
    if (a.type == ActionType::Build && std::find(s.magistrate_nums.begin(),s.magistrate_nums.end(),
        NativeGameAdapter::char_number(s.players[index].role_id)) != s.magistrate_nums.end()) result -= 8;
    return true;
  }
  static double character_target_value(const NativeGameState& s, int index, int number) {
    double best = 0;
    for (const auto& role : s.char_deck) if (NativeGameAdapter::char_number(role)==number) {
      double total=0,weights=0;
      for (size_t i=0;i<s.players.size();++i) if (static_cast<int>(i)!=index) {
        const auto& t=s.players[i];
        // Affinity uses public economy only, never the target's actual role/hand.
        const double affinity=1 + color_count(t,role_income(role)) * 0.4 +
          ((role=="architect" || role=="alchemist") ? std::min(t.gold,8)*0.15 : 0);
        const double pressure = native_player_score(s,static_cast<int>(i))*0.1 +
          (t.city.size()+1>=static_cast<size_t>(s.end_districts)?3:0);
        const double payoff = s.players[index].role_id=="thief" ? t.gold : 1+pressure;
        total += affinity*payoff; weights += affinity;
      }
      double utility = (role=="architect" ? 2.5 : role=="navigator" || role=="scholar" ? 2 :
        role=="merchant" || role=="king" ? 1.3 : 1.0);
      if (s.players[index].role_id=="thief") utility=1;
      best=std::max(best,utility+(weights?total/weights:0));
    }
    return best;
  }
  static double district_payoff(const NativeGameState& s, int index, const NativeSearchAction& a) {
    NativeGameAdapter rules;
    auto next=s;
    next.deck.load({},{});
    next.magistrate_signed=-1;
    if (!rules.apply(next,index,a)) return -100;
    if (s.pending_kind=="diplomat_mine") {
      double best=-100;
      for (const auto& choice:rules.legal_actions(next,index)) if (choice.type==ActionType::ChooseDistrict)
        best=std::max(best,district_payoff(next,index,choice));
      return best;
    }
    double gain = native_player_score(next,index)-native_player_score(s,index);
    gain += (next.players[index].gold-s.players[index].gold)*money_value(s.players[index]);
    gain += (static_cast<double>(next.players[index].city.size())-s.players[index].city.size())*2;
    const int target=s.find_player(a.target);
    if (target>=0 && target!=index) {
      const double damage=native_player_score(s,target)-native_player_score(next,target);
      gain += damage * (target==leader(s)?0.8:0.35);
      if (s.players[target].city.size()+1>=static_cast<size_t>(s.end_districts) &&
          next.players[target].city.size()<s.players[target].city.size()) gain += 5;
    }
    // Remaining cash may be needed for our best construction this turn.
    double before_build=0,after_build=0;
    for (const auto& c:s.players[index].hand) if(c.cost<=s.players[index].gold)
      before_build=std::max(before_build,hand_value(s,s.players[index],c));
    for (const auto& c:next.players[index].hand) if(c.cost<=next.players[index].gold)
      after_build=std::max(after_build,hand_value(next,next.players[index],c));
    return gain - std::max(0.0,before_build-after_build)*0.5;
  }
  static double score_action(const NativeGameState& s, int index,
                             const NativeSearchAction& a, uint32_t& rng) {
    const auto& p = s.players[index];
    const auto type = a.type;
    if (type == ActionType::ConfirmRound) return 100;
    if (type == ActionType::Reaction) {
      const bool use = a.name == "use";
      if (s.reaction_kind == "magistrate" || s.reaction_kind == "blackmailer") return use ? 100 : 0;
      const auto& c = s.reaction_card;
      return use == (c.cost >= 3 && p.gold >= 2) ? 80 : 0;
    }
    if (type == ActionType::DraftPick || type == ActionType::DraftDiscard) {
      const double value = role_value(s, index, a.name);
      const double noise_scale = p.bot_level == "easy" ? 4.0 : p.bot_level == "hard" ? 0.25 : 1.2;
      return (type == ActionType::DraftPick ? value : -value) + noise(rng, noise_scale);
    }
    if (s.pending_kind == "blackmailer_threat") return type == (p.gold >= 4 ? ActionType::BlackmailerBribe : ActionType::BlackmailerRefuse) ? 100 : 0;
    if (s.pending_kind == "wizard_choice") {
      const auto selected = std::find_if(s.pending_cards.begin(), s.pending_cards.end(),
        [&](const DistrictCard& card) { return card.uid == s.pending_uid; });
      if (selected==s.pending_cards.end()) return -10;
      if (type==ActionType::WizardTake) return hand_value(s,p,*selected);
      if (type==ActionType::WizardBuild) {
        auto next=s;
        next.players[index].city.push_back({*selected,selected->name,selected->purple_effect,{},false,false,s.round});
        if(next.first_to_finish<0 && next.players[index].city.size()>=static_cast<size_t>(s.end_districts))next.first_to_finish=index;
        next.players[index].gold-=selected->cost;
        return position_value(next,index)-position_value(s,index);
      }
      return -10;
    }
    if (s.pending_kind == "magician_choice") {
      int max_hand = 0; for (size_t i=0;i<s.players.size();++i) if (static_cast<int>(i)!=index) max_hand=std::max(max_hand, static_cast<int>(s.players[i].hand.size()));
      const bool swap = (p.hand.size() <= 1 && max_hand >= 2) || (p.hand.size() >= 3 && max_hand >= 4);
      return (a.mode == (swap ? "swap" : "redraw")) ? 30 : 0;
    }
    if (s.pending_kind == "navigator_bonus") return a.mode == ((p.gold < 6) ? "gold" : "cards") ? 20 : 0;
    if (s.pending_kind == "emperor_take") {
      const int target = s.pending_target;
      return a.mode == ((target >= 0 && s.players[target].gold >= 2) ? "gold" : "card") ? 20 : 0;
    }
    if (s.pending_kind == "spy_color") {
      const int target = s.pending_target;
      if (target >= 0) { int best=0; std::string color; for (const auto& d:s.players[target].city) { int count=color_count(s.players[target],d.card.color); if(count>best){best=count;color=d.card.color;} } if(a.color==color) return 30; }
      return 1;
    }
    if (s.pending_kind.empty() && s.has_turn && s.active_player == index && s.turn_phase == "bewitched")
      return type == ActionType::TakeGold ? 90 : -10;
    if (s.pending_kind.empty() && s.has_turn && s.active_player == index && !s.resources_taken) {
      if (p.role_id == "navigator") return type == (p.gold < 6 ? ActionType::TakeGold : ActionType::TakeCards) ? 80 : 0;
      const bool hand_poor = p.hand.size() <= 1;
      const bool gold_hungry = p.gold < 3;
      const int best_cost = [&] { int value=1000; for(const auto& c:p.hand) if(c.cost<=p.gold+2) value=std::min(value,c.cost); return value; }();
      const bool near_finish = p.city.size() >= static_cast<size_t>(std::max(0,s.end_districts-2));
      const double gold_score = (p.gold < 2 ? 1.2 : 0) + (near_finish ? 2 : 0) + (gold_hungry && best_cost < 1000 ? 1.0 : 0);
      const double card_score = (hand_poor ? 2.6 : 0) + (p.hand.size() <= 2 ? 1.0 : 0);
      const auto wanted = gold_score > card_score || (gold_hungry && best_cost < 1000)
        ? ActionType::TakeGold : ActionType::TakeCards;
      return type == wanted ? 80 : 0;
    }
    if (s.pending_kind.empty() && s.has_turn && s.active_player == index &&
        !s.ability_used && type == ActionType::Ability) {
      if (!should_use_ability(s,index)) return -30;
      if (p.role_id=="warlord" || p.role_id=="marshal" || p.role_id=="diplomat") {
        auto pending=s;
        pending.pending_kind=p.role_id=="warlord"?"warlord_destroy":p.role_id=="marshal"?"marshal_seize":"diplomat_mine";
        NativeGameAdapter rules;
        double benefit=0;
        for(const auto& candidate:rules.legal_actions(pending,index))
          if(candidate.type==ActionType::ChooseDistrict)benefit=std::max(benefit,district_payoff(pending,index,candidate));
        return benefit>0?100+benefit*8:-30;
      }
      return 110;
    }
    if (s.pending_kind.empty() && s.has_turn && s.active_player == index && !s.income_taken && type == ActionType::Income) {
      const auto income = role_income(p.role_id);
      const bool any_color = std::any_of(p.city.begin(),p.city.end(),[](const auto& d){return d.effect=="anyColorIncome";});
      return (!income.empty() && (color_count(p,income)>0 || any_color)) ? 105 : 0;
    }
    if (type == ActionType::BlackmailerSigned || type == ActionType::MagistrateSigned || type == ActionType::MagistrateChar || type == ActionType::BlackmailerChar || type == ActionType::ChooseChar) {
      return character_target_value(s,index,a.num) + noise(rng,p.bot_level=="hard"?0.1:1.0);
    }
    if (type == ActionType::ChoosePlayer || type == ActionType::SpyTarget || type == ActionType::WizardTarget || type == ActionType::EmperorCrown) {
      const auto it = std::find_if(s.players.begin(), s.players.end(), [&](const auto& x) { return x.id == a.target; });
      if (it == s.players.end()) return 0;
      const int target = static_cast<int>(it - s.players.begin());
      const auto& t = *it;
      if (s.pending_kind == "emperor_crown") return -native_player_score(s,target)*0.4 +
        (t.gold>0?money_value(p):0.5) - (t.city.size()+1>=static_cast<size_t>(s.end_districts)?4:0);
      if (s.pending_kind == "magician_swap") return static_cast<double>(t.hand.size()) * 2.5;
      if (s.pending_kind == "bishop_payer") return t.gold;
      return t.hand.size() * 0.9 + t.gold * 0.25 + t.city.size() * 0.7 + (target == leader(s) ? 3 : 0);
    }
    if (type == ActionType::Build) {
      const auto* c = card_by_uid(p.hand, a.uid);
      if (c && p.city.size()+1>=static_cast<size_t>(s.end_districts) && s.first_to_finish<0) {
        auto next=s;
        if(next.build(c->uid,c->name,c->purple_effect) && position_value(next,index)<position_value(s,index))return -40;
      }
      return 100 + (c ? card_value(s, p, *c) : 0);
    }
    if (type == ActionType::TakeGold) return p.gold < 3 ? 70 : 38;
    if (type == ActionType::TakeCards) return p.hand.size() < 2 ? 68 : 35;
    if (type == ActionType::Income) return 65;
    if (type == ActionType::Ability) return 75;
    if (type == ActionType::AbilitySkip || type == ActionType::EndTurn || type == ActionType::PendingBack) return 0;
    if (type == ActionType::Smithy) {
      const auto count = std::min<size_t>(3, s.deck.deck_count() + s.deck.discard_count());
      const double benefit = count * draw_value(s,p) - 2 * money_value(p);
      return benefit > 0 ? 100 + benefit : -30;
    }
    if (type == ActionType::Lab || type == ActionType::Museum) {
      const auto* c = card_by_uid(p.hand, a.secondary_uid);
      if (!c) return -30;
      const double benefit = (type == ActionType::Lab ? money_value(p) : 1.0) - hand_value(s,p,*c);
      return benefit > 0 ? 100 + benefit : -30;
    }
    if (type == ActionType::DrawKeep || type == ActionType::ScholarPick || type == ActionType::WizardCard) {
      const auto* c = card_by_uid(s.pending_cards, a.uid);
      if (!c) c = card_by_uid(s.players[index].hand, a.uid);
      return c ? card_value(s,p,*c) : 0;
    }
    if (type == ActionType::ProphetGive) { const auto* c=card_by_uid(p.hand,a.uid); return c ? -card_value(s,p,*c) : 0; }
    if (type == ActionType::ChooseCards) {
      if (s.pending_kind == "magician_redraw") {
        const auto* c = card_by_uid(p.hand, a.uid);
        if (!c || a.mode != "use") return 0;
        // Replacement cards are unknown; use an expectation, never inspect deck order.
        return 2.8 - hand_value(s,p,*c);
      }
      double score = 0; for (const auto& uid : a.selected_uids) { const auto* c=card_by_uid(p.hand,uid); if(c) score-=card_value(s,p,*c); }
      return score;
    }
    if (type == ActionType::ChooseDistrict) {
      const NativeDistrict* d=nullptr;
      for (const auto& owner:s.players) for (const auto& district:owner.city) if(district.card.uid==a.uid) d=&district;
      if (!d) return 0;
      if (s.pending_kind == "artist") return 1-money_value(p);
      return district_payoff(s,index,a);
    }
    if (type == ActionType::ArtistDone) return 0;
    if (type == ActionType::MonkTake) {
      int richest=0; for(size_t i=0;i<s.players.size();++i) if(static_cast<int>(i)!=index) richest=std::max(richest,s.players[i].gold);
      return richest > p.gold ? 80 : -1;
    }
    if (type == ActionType::MonkResource || type == ActionType::AbbotResource) {
      return (p.gold < 6 ? a.gold : a.cards) * 0.1 - std::abs(a.gold - std::max(0, 6-p.gold))*0.01;
    }
    if (type == ActionType::EmperorTake) return a.mode == "gold" ? 1 : 0;
    if (type == ActionType::TaxCollect || type == ActionType::BlackmailerBribe) return 10;
    return 5;
  }
};

}  // namespace citadels::native
