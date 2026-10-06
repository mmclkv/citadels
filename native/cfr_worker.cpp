#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <filesystem>
#include <iostream>
#include "cfr_core.hpp"
#include "cfr_information.hpp"
#include "game_setup.hpp"
#ifdef _WIN32
#include <windows.h>
#include <process.h>
#else
#include <unistd.h>
#endif
using namespace citadels::native;

namespace {
void save_checkpoint(const CfrTable& table, const std::string& path) {
  const auto destination = std::filesystem::u8path(path);
  auto temporary = destination;
#ifdef _WIN32
  temporary += ".tmp-" + std::to_string(_getpid());
#else
  temporary += ".tmp-" + std::to_string(getpid());
#endif
  { std::ofstream stream(temporary, std::ios::binary | std::ios::trunc); table.save(stream); stream.close();
    if (!stream) throw std::runtime_error("Cannot finish CFR checkpoint"); }
#ifdef _WIN32
  if (!MoveFileExW(temporary.c_str(), destination.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    throw std::runtime_error("Cannot atomically publish CFR checkpoint");
#else
  std::filesystem::rename(temporary, destination);
#endif
}
void load_checkpoint(CfrTable& table, const std::string& path, const std::string& contract) {
  std::ifstream stream(std::filesystem::u8path(path), std::ios::binary);
  if (!stream) throw std::runtime_error("Cannot open CFR policy: " + path);
  table.load(stream, contract);
}

bool episode(CfrTable& table, NativeGameState state, int updating, double exploration,
             int max_steps, std::mt19937& rng) {
  NativeGameAdapter rules; CfrHistory history(state);
  std::vector<CfrTraceStep> trace;
  long double my = 0, opponents = 0, sampled = 0;
  for (int step = 0; state.phase != NativePhase::GameOver; ++step) {
    if (step >= max_steps) return false;  // No updates from truncated games.
    const int actor = rules.next_player(state);
    if (actor < 0) throw std::runtime_error("MCCFR game has no actor before terminal");
    const auto legal = rules.legal_actions(state, actor);
    const auto actions = cfr_action_set(state, actor, legal);
    const auto info = history.information(state, actor);
    const auto policy = cfr_normalize(table.lookup(info, actions.keys).regrets);
    auto behavior = policy;
    if (actor == updating) for (double& p : behavior) p = (1-exploration)*p + exploration/behavior.size();
    const auto selected = cfr_sample(behavior, rng);
    trace.push_back({info, actor, selected, policy, behavior[selected], my, opponents, sampled});
    const auto log_policy = policy[selected] == 0 ? -std::numeric_limits<long double>::infinity() : std::log(static_cast<long double>(policy[selected]));
    if (actor == updating) my += log_policy; else opponents += log_policy;
    sampled += std::log(static_cast<long double>(behavior[selected]));
    const auto& copies = actions.indices[selected];
    const auto& action = legal[copies[std::uniform_int_distribution<size_t>(0, copies.size()-1)(rng)]];
    const auto before = state;
    if (!rules.apply(state, actor, action)) {
      std::ostringstream message; message << "MCCFR engine rejected legal action: role=" << before.players[actor].role_id
          << ", pending=" << before.pending_kind << ", round=" << before.round << ", action=";
      write_native_action(message, action); throw std::runtime_error(message.str());
    }
    history.transition(before, actor, action, state);
  }
  cfr_update_episode(table, trace, updating, native_terminal_reward(state, updating));
  return true;
}

void train(CfrTable& table, const JsonValue& request) {
  const std::string contract = string_field(request, "contract");
  if (contract.empty()) throw std::runtime_error("Missing CFR rules contract");
  const auto resume = string_field(request, "resume");
  if (!resume.empty()) load_checkpoint(table, resume, contract); else table = CfrTable{};
  table.contract = contract;
  const int iterations = int_field(request, "iterations", 1000);
  const int low = int_field(request, "minPlayers", 4), high = int_field(request, "maxPlayers", 8);
  const int limit = int_field(request, "maxSteps", 60000), save_every = int_field(request, "saveEvery", 10);
  const double exploration = required_field(request, "exploration").as_number();
  if (iterations < 1 || low < 2 || high > 8 || low > high || limit < 1 || save_every < 1 ||
      !std::isfinite(exploration) || exploration <= 0 || exploration > 1)
    throw std::runtime_error("Invalid MCCFR training options");
  const auto output = string_field(request, "output");
  if (output.empty()) throw std::runtime_error("Missing CFR checkpoint output");
  uint64_t truncated = 0;
  const uint32_t seed = static_cast<uint32_t>(int_field(request, "seed", 20260913));
  for (int iteration = 0; iteration < iterations; ++iteration) {
    const uint64_t absolute = table.iterations;
    const int players = low + static_cast<int>(absolute % (high-low+1));
    for (int updating = 0; updating < players; ++updating) {
      std::seed_seq seeds{seed, static_cast<uint32_t>(absolute), static_cast<uint32_t>(absolute >> 32), static_cast<uint32_t>(updating)};
      std::mt19937 rng(seeds); const uint32_t world_seed = rng();
      JsonValue::Object setup;
      setup.emplace("seed", JsonValue(JsonValue::Storage(static_cast<double>(world_seed))));
      setup.emplace("catalog", required_field(request, "catalog"));
      setup.emplace("endDistricts", JsonValue(JsonValue::Storage(static_cast<double>(int_field(request, "endDistricts", 8)))));
      setup.emplace("charSetMode", JsonValue(JsonValue::Storage(string_field(request, "charSetMode", "random"))));
      JsonValue::Array seats;
      for (int p = 0; p < players; ++p) {
        JsonValue::Object seat;
        seat.emplace("id", JsonValue(JsonValue::Storage("cfr-" + std::to_string(p))));
        seat.emplace("isBot", JsonValue(JsonValue::Storage(true)));
        seat.emplace("botType", JsonValue(JsonValue::Storage(std::string("cfr"))));
        seats.emplace_back(JsonValue::Storage(std::move(seat)));
      }
      setup.emplace("seats", JsonValue(JsonValue::Storage(std::move(seats))));
      if (!episode(table, create_native_game(JsonValue(JsonValue::Storage(std::move(setup)))), updating, exploration, limit, rng)) ++truncated;
    }
    ++table.iterations;
    if ((iteration+1) % save_every == 0 || iteration+1 == iterations) save_checkpoint(table, output);
    std::cout << "{\"t\":\"cfr_progress\",\"iterations\":" << table.iterations << ",\"episodes\":" << table.episodes
              << ",\"informationSets\":" << table.entries.size() << ",\"truncated\":" << truncated << "}\n" << std::flush;
  }
}
}

int main() {
  CfrTable table; bool configured = false;
  try {
    const char* policy = std::getenv("CITADELS_CFR_POLICY");
    const char* contract = std::getenv("CITADELS_CFR_CONTRACT");
    if (policy && *policy) {
      if (!contract || !*contract) throw std::runtime_error("Missing CITADELS_CFR_CONTRACT");
      load_checkpoint(table, policy, contract); configured = true;
    }
  } catch (const std::exception& error) {
    std::cout << "{\"t\":\"error\",\"error\":"; write_json_string(std::cout, error.what()); std::cout << "}\n" << std::flush;
    return 1;
  }
  std::string line;
  while (std::getline(std::cin, line)) {
    try {
      const auto request = parse_json(line);
      if (string_field(request, "mode") == "train") {
        train(table, request); configured = true;
        std::cout << "{\"t\":\"cfr_done\"}\n" << std::flush;
      } else if (string_field(request, "mode") == "infer") {
        const auto actions = string_array_field(request, "actions");
        if (actions.empty() || !std::is_sorted(actions.begin(), actions.end()) ||
            std::adjacent_find(actions.begin(), actions.end()) != actions.end()) throw std::runtime_error("Invalid CFR action keys");
        bool hit = false; const auto policy = table.average(string_field(request, "information"), actions, hit);
        std::mt19937 rng(static_cast<uint32_t>(number_field(request, "seed", 1)));
        std::cout << "{\"t\":\"cfr_result\",\"selected\":" << cfr_sample(policy, rng)
                  << ",\"hit\":" << (hit ? "true" : "false") << ",\"configured\":" << (configured ? "true" : "false") << "}\n" << std::flush;
      } else throw std::runtime_error("Unknown CFR command");
    } catch (const std::exception& error) {
      std::cout << "{\"t\":\"error\",\"error\":"; write_json_string(std::cout, error.what()); std::cout << "}\n" << std::flush;
    }
  }
}
