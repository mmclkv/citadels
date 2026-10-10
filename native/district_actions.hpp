#pragma once

// Included inside NativeGameAdapter: the same choices drive humans, NPCs and MCTS.
  static std::vector<NativeSearchAction> district_actions(const NativeGameState& s, int actor) {
    std::vector<NativeSearchAction> result;
    const auto add = [&](std::string mode, std::string uid = {}, std::string target = {}, std::string card = {}) {
      NativeSearchAction a{ActionType::DistrictEffect}; a.name = std::move(mode); a.uid = std::move(uid);
      a.target = std::move(target); a.secondary_uid = std::move(card); result.push_back(std::move(a));
    };
    if (s.pending_kind == "lighthouse") {
      if (actor != s.pending_target) return result;
      for (const auto& card : s.pending_cards) add("lighthouse_pick", card.uid);
      add("lighthouse_skip"); return result;
    }
    if (s.pending_kind == "bell_tower") {
      if (actor != s.pending_target) return result;
      add("bell_enable", s.pending_uid); add("bell_skip"); return result;
    }
    if (s.pending_kind == "theater_exchange") {
      if (s.pending_queue.empty() || actor != s.pending_queue.front()) return result;
      for (size_t own = 0; own < s.players[actor].role_ids.size(); ++own)
        for (size_t target = 0; target < s.players.size(); ++target) if (static_cast<int>(target) != actor)
          if (!s.players[target].role_ids.empty()) add("theater_swap", std::to_string(own), s.players[target].id);
      add("theater_skip"); return result;
    }
    if (s.pending_kind == "ballroom") {
      if (actor != s.active_player) return result;
      add("ballroom_thanks"); add("ballroom_skip"); return result;
    }
    if (s.pending_kind == "thieves_den") {
      if (actor != s.active_player) return result;
      const auto& p = s.players[actor];
      auto card = std::find_if(p.hand.begin(), p.hand.end(), [&](const DistrictCard& c) { return c.uid == s.pending_uid; });
      if (card == p.hand.end()) return result;
      const int cost = s.building_cost(p, *card);
      if (s.building_cards.size() < static_cast<size_t>(cost)) for (const auto& other : p.hand)
        if (other.uid != card->uid && std::find(s.building_cards.begin(), s.building_cards.end(), other.uid) == s.building_cards.end())
          add("thieves_discard", other.uid);
      if (p.gold >= cost - static_cast<int>(s.building_cards.size())) add("thieves_pay", card->uid);
      add("thieves_cancel"); return result;
    }
    if (actor != s.active_player || !s.resources_taken || !s.pending_kind.empty() ||
        !s.reaction_kind.empty() || s.turn_phase == "hospital" || s.turn_phase == "bewitched" || s.turn_phase == "witch_declared") return result;
    const auto& p = s.players[actor];
    for (const auto& card : p.hand) {
      if (card.purple_effect == "thievesDen" && s.can_build_card(p, card, true) && p.hand.size() - 1 + p.gold >= static_cast<size_t>(s.building_cost(p, card)))
        add("thieves_begin", card.uid);
      for (const auto& own : p.city) {
        if (!s.can_build_card(p, card, true, false, own.card.uid)) continue;
        if (own.effect == "framework") add("framework", own.card.uid, {}, card.uid);
        if (card.purple_effect == "necropolis") add("necropolis", own.card.uid, {}, card.uid);
      }
    }
    for (const auto& own : p.city) if (own.effect == "armory")
      for (size_t target = 0; target < s.players.size(); ++target) {
        if (s.city_count(static_cast<int>(target)) >= s.completion_limit()) continue;
        for (const auto& victim : s.players[target].city) if (victim.card.uid != own.card.uid)
          add("armory", own.card.uid, s.players[target].id, victim.card.uid);
      }
    return result;
  }

  static bool apply_district(NativeGameState& s, int actor, const NativeSearchAction& a) {
    const auto choices = district_actions(s, actor);
    if (std::none_of(choices.begin(), choices.end(), [&](const NativeSearchAction& legal) {
      return a.name == legal.name && a.uid == legal.uid && a.target == legal.target && a.secondary_uid == legal.secondary_uid;
    })) return false;
    const auto clear_pending = [&]() { s.pending_kind.clear(); s.pending_cards.clear(); s.pending_uid.clear(); s.pending_target = -1; };
    if (a.name == "framework" || a.name == "necropolis") {
      s.building_mode = a.name; s.building_source = a.uid;
      return s.start_build(a.secondary_uid);
    }
    if (a.name == "armory") {
      const int target = s.find_player(a.target);
      s.discard_district(actor, a.uid); s.discard_district(target, a.secondary_uid); return true;
    }
    if (a.name == "thieves_begin") {
      s.pending_kind = "thieves_den"; s.pending_uid = a.uid;
      s.building_mode = "thievesDen"; s.building_cards.clear(); return true;
    }
    if (a.name == "thieves_discard") { s.building_cards.push_back(a.uid); return true; }
    if (a.name == "thieves_cancel") {
      clear_pending(); s.building_mode.clear(); s.building_cards.clear(); return true;
    }
    if (a.name == "thieves_pay") { clear_pending(); return s.start_build(a.uid); }
    if (a.name == "lighthouse_pick" || a.name == "lighthouse_skip") {
      if (a.name == "lighthouse_pick") {
        auto& deck = s.deck.deck_cards();
        auto it = std::find_if(deck.begin(), deck.end(), [&](const DistrictCard& c) { return c.uid == a.uid; });
        if (it == deck.end()) return false;
        s.players[actor].hand.push_back(*it); deck.erase(it);
      }
      s.deck.return_and_shuffle({}, s.rng); clear_pending(); return true;
    }
    if (a.name == "bell_enable" || a.name == "bell_skip") {
      if (a.name == "bell_enable") {
        s.enabled_bell_towers.push_back(a.uid);
        if (s.first_to_finish < 0) {
          for (size_t i = 0; i < s.players.size(); ++i) if (s.city_count(static_cast<int>(i)) >= s.completion_limit())
            s.first_finishers.push_back(static_cast<int>(i));
          if (!s.first_finishers.empty()) s.first_to_finish = s.first_finishers.front();
        }
      }
      clear_pending(); return true;
    }
    if (a.name == "ballroom_thanks" || a.name == "ballroom_skip") {
      clear_pending();
      if (a.name == "ballroom_thanks") return true;
      s.turn_phase = "skipped"; return s.end_turn();
    }
    if (a.name == "theater_swap" || a.name == "theater_skip") {
      if (a.name == "theater_swap") {
        const int target = s.find_player(a.target);
        const size_t slot = std::min(s.players[target].role_ids.size() - 1, static_cast<size_t>(s.rng.next() * s.players[target].role_ids.size()));
        std::swap(s.players[actor].role_ids[std::stoi(a.uid)], s.players[target].role_ids[slot]);
      }
      s.pending_queue.erase(s.pending_queue.begin());
      if (!s.pending_queue.empty()) {
        s.active_player = s.pending_queue.front(); s.players[s.active_player].role_id.clear(); return true;
      }
      clear_pending(); s.call_queue.clear();
      for (size_t i = 0; i < s.players.size(); ++i) for (const auto& role : s.players[i].role_ids)
        s.call_queue.push_back({role, s.role_number(role), static_cast<int>(i)});
      std::stable_sort(s.call_queue.begin(), s.call_queue.end(), [](const NativeCallEntry& x, const NativeCallEntry& y) { return x.number < y.number; });
      s.call_index = -1; s.turn_phase = "setup"; return s.end_turn();
    }
    return false;
  }
