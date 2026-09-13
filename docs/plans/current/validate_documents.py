#!/usr/bin/env python3
"""Validate design data only. Does not execute or certify the game.

The default invocation is read-only. Pass --write-report when the current
DOCUMENT_CHECKS.json should be replaced with the resulting document check.
"""
from pathlib import Path
from collections import Counter, defaultdict
from datetime import date
import argparse
import json
import re
import sys


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--write-report', action='store_true',
        help='write DOCUMENT_CHECKS.json after the read-only checks pass/fail',
    )
    args = parser.parse_args(argv)

    root = Path(__file__).resolve().parent
    checks = {}
    data = {
        p.name: json.loads(p.read_text(encoding='utf-8'))
        for p in root.glob('*.json')
        if p.name != 'DOCUMENT_CHECKS.json'
    }
    checks['all_json_parse'] = True
    r = data['INITIAL_RULES.json']
    requirements_doc = data['REQUIREMENTS.json']
    tests_doc = data['ACCEPTANCE_TESTS.json']
    q = requirements_doc['requirements']
    tests = tests_doc['tests']
    roster = data['ENEMY_ROSTER.json']
    members = roster['members']
    layout = data['INTERIOR_LAYOUTS.json']
    req_ids = [x['id'] for x in q]
    test_ids = [x['id'] for x in tests]
    coverage = {i for t in tests for i in t['requirement_ids']}

    checks['document_versions_v5'] = (
        requirements_doc['version'] == '5.0'
        and tests_doc['version'] == '5.0'
        and r['document_version'] == '5.0'
        and roster['version'] == '5.0'
        and layout['version'] == '5.0'
    )
    checks['unique_requirement_ids'] = len(req_ids) == len(set(req_ids))
    checks['unique_test_ids'] = len(test_ids) == len(set(test_ids))
    checks['all_test_references_exist'] = coverage <= set(req_ids)
    checks['all_requirements_have_planned_tests'] = set(req_ids) <= coverage
    checks['no_game_test_claimed_run'] = (
        tests_doc['execution_status'] == 'not_run'
        and all(x['execution_status'] == 'not_run' for x in tests)
    )
    main_text = (root / 'PRODUCT_REQUIREMENTS.md').read_text(encoding='utf-8')
    checks['main_counts_match'] = (
        f'{len(q)}件の要件' in main_text
        and f'{len(tests)}件の検査' in main_text
    )
    checks['markdown_requirement_refs_exist'] = all(
        x in req_ids
        for p in root.glob('*.md')
        for x in re.findall(r'REQ-\d{2}', p.read_text(encoding='utf-8'))
    )

    checks['enemy_roster_exactly_30'] = (
        len(members) == 30
        == r['team_profiles']['enemy']['total_npc_slots']
        == roster['enemy_npc_slots']
    )
    checks['unique_npc_ids'] = len({x['id'] for x in members}) == 30
    checks['no_extra_commander'] = (
        r['team_profiles']['enemy']['extra_commander_slots'] == 0
        and all(not x['extra_slot'] for x in members)
    )
    expected_roles = {
        'shooter': 4,
        'shooter_guard': 4,
        'ammo_carrier': 8,
        'internal_soldier': 14,
    }
    checks['role_counts_match'] = (
        dict(Counter(x['role'] for x in members))
        == roster['role_counts'] == r['enemy_interior']['role_counts']
        == expected_roles
    )
    checks['four_roles_all_present'] = set(roster['role_counts']) == set(expected_roles)
    expected_ticks = r['simulation']['ticks_per_second'] * 20
    checks['respawn_20_seconds'] = (
        expected_ticks == 1200 == r['team_profiles']['enemy']['respawn_ticks']
        and r['team_profiles']['enemy']['respawn_seconds'] == 20
        and all(x['respawn_ticks'] == 1200 for x in members)
    )
    checks['confirmed_count_and_delay_separate_from_proposals'] = (
        r['user_confirmed_requirements']['enemy_npc_slots'] == 30
        and r['user_confirmed_requirements']['enemy_npc_respawn_seconds'] == 20
        and 'turrets' not in r['user_confirmed_requirements']
    )
    checks['no_shared_old_respawn_default'] = (
        'respawn_ticks' not in r['actor'] and 'team' not in r
    )
    player_profile = r['team_profiles']['player']
    player_cannon = r['cannon']['team_profiles']['player']
    checks['player_scope_preserved'] = (
        player_profile['total_actors'] == 3
        and player_profile['respawn_ticks'] == 300
        and 'five_second' in player_profile['basis']
        and player_cannon['turrets'] == 4
        and player_cannon['supply_ports'] == 4
        and player_cannon['loading_stations'] == 4
        and player_cannon['operator_assignment'] == {
            'scope': 'home_player_and_support_only',
            'actor_ids': ['P1', 'P2', 'P3'],
            'dedicated_per_turret': False,
        }
        and r['respawn']['player_respawn_pad_ids']
        == ['player_respawn_pad_P1', 'player_respawn_pad_P2', 'player_respawn_pad_P3']
        and next(room for room in layout['rooms'] if room['id'] == 'respawn')['player_respawn_pads']
        == [
            {
                'id': 'player_respawn_pad_P1',
                'assigned_npc_id': 'P1',
                'cell': [58, 35],
                'geometry_status': 'document_coordinate_proposal_not_collision_tested',
            },
            {
                'id': 'player_respawn_pad_P2',
                'assigned_npc_id': 'P2',
                'cell': [60, 35],
                'geometry_status': 'document_coordinate_proposal_not_collision_tested',
            },
            {
                'id': 'player_respawn_pad_P3',
                'assigned_npc_id': 'P3',
                'cell': [62, 35],
                'geometry_status': 'document_coordinate_proposal_not_collision_tested',
            },
        ]
    )
    checks['player_spectator_five_seconds'] = (
        r['team_profiles']['player']['respawn_seconds'] == 5
        and r['respawn']['player_spectator_ticks'] == 300
        and r['respawn']['player_respawn_room_id'] == 'respawn'
        and r['respawn']['player_input_policy_during_spectator']
        == 'disabled_move_attack_load_command'
    )

    room_ids = {x['id'] for x in layout['rooms']}
    ordinary = {x['id'] for x in layout['rooms'] if x['kind'] != 'core'}
    checks['room_counts_match'] = (
        len(room_ids) == 13
        and len(ordinary) == 12 == r['enemy_interior']['non_core_rooms']
    )
    checks['all_home_initial_respawn_rooms_ordinary'] = all(
        x[k] in ordinary for x in members for k in ['home_room_id', 'initial_room_id', 'respawn_room_id']
    )
    pads = {
        pad['id']: (room['id'], pad['assigned_npc_id'])
        for room in layout['rooms']
        for pad in room['recovery_pads']
    }
    checks['thirty_dedicated_home_pads'] = (
        len(pads) == 30
        and all(pads.get(m['respawn_pad_id']) == (m['home_room_id'], m['id']) for m in members)
    )
    core_room = next(x for x in layout['rooms'] if x['id'] == 'core')
    checks['no_core_spawn_pads'] = not core_room['recovery_pads']
    expected_headcounts = {
        'ammo_a': 2, 'ammo_b': 2, 'ammo_c': 2, 'ammo_d': 2,
        'battery_a': 2, 'battery_b': 2, 'battery_c': 2, 'battery_d': 2,
        'central_corridor': 8, 'repair': 3, 'command': 3,
    }
    checks['room_headcounts_match'] = dict(
        Counter(x['home_room_id'] for x in members)
    ) == expected_headcounts
    checks['layout_grid_126x70'] = (
        layout['grid']['width_cells'] == 126
        and layout['grid']['height_cells'] == 70
        and layout['grid']['enemy_transform']['point'] == '(125-x,y)'
        and layout['grid']['enemy_transform']['rect'] == '(126-x1,y0,126-x0,y1)'
    )
    rects = {
        x['id']: x['rect_cells'] for x in layout['rooms']
    }
    rects.update({x['id']: x['rect_cells'] for x in layout['corridor_geometry']})
    checks['layout_rectangles_in_grid'] = all(
        len(rect) == 4 and 0 <= rect[0] < rect[2] <= 126
        and 0 <= rect[1] < rect[3] <= 70
        for rect in rects.values()
    )
    passage_ids = {x['id'] for x in layout['passages']}
    checks['passages_have_concrete_rectangles'] = (
        len(passage_ids) == len(layout['passages'])
        and all(
            x.get('passage_id') in passage_ids
            and len(next(p for p in layout['passages'] if p['id'] == x['passage_id'])['rect_cells']) == 4
            for x in layout['links']
        )
    )

    turrets = layout['turrets']
    by_id = {x['id']: x for x in members}
    turret_ids = {x['id'] for x in turrets}
    checks['four_distinct_equipment_turrets'] = (
        len(turrets) == len(turret_ids) == 4
        and all(not x['counts_as_npc'] for x in turrets)
        and layout['operator_mapping']['operator_npc_id_scope'] == 'enemy_castle_only'
        and layout['operator_mapping']['home_castle']['actor_ids'] == ['P1', 'P2', 'P3']
        and layout['operator_mapping']['enemy_castle']['actor_ids'] == ['E01', 'E02', 'E03', 'E04']
    )
    room_rect_by_id = {x['id']: x['rect_cells'] for x in layout['rooms']}

    def cell_inside_room(item):
        rect = room_rect_by_id[item['room_id']]
        cell = item.get('cell')
        return (
            isinstance(cell, list) and len(cell) == 2
            and all(isinstance(v, int) for v in cell)
            and rect[0] <= cell[0] < rect[2]
            and rect[1] <= cell[1] < rect[3]
        )

    checks['equipment_cells_are_explicit_r1_proposals'] = (
        layout.get('equipment_coordinate_basis', {}).get('status')
        == 'r1_display_coordinate_proposal_not_collision_tested'
        and len(turrets) == len(layout['supply_ports']) == 4
        and len({tuple(x.get('cell', [])) for x in turrets}) == 4
        and len({tuple(x.get('cell', [])) for x in layout['supply_ports']}) == 4
        and all(
            x.get('geometry_status')
            == 'r1_display_coordinate_proposal_not_collision_tested'
            and cell_inside_room(x)
            for x in turrets + layout['supply_ports']
        )
    )
    checks['turret_shooter_bijection'] = (
        len({x['operator_npc_id'] for x in turrets}) == 4
        and all(
            by_id[x['operator_npc_id']]['role'] == 'shooter'
            and by_id[x['operator_npc_id']]['turret_id'] == x['id']
            and by_id[x['operator_npc_id']]['home_room_id'] == x['room_id']
            for x in turrets
        )
    )
    checks['guard_references_match'] = all(
        m['guarded_turret_id'] in turret_ids
        and by_id[m['guarded_npc_id']]['role'] == 'shooter'
        and by_id[m['guarded_npc_id']]['home_room_id'] == m['home_room_id']
        for m in members if m['role'] == 'shooter_guard'
    )
    checks['carrier_destinations_exist'] = all(
        set(m['delivery_turret_ids']) <= turret_ids
        for m in members if m['role'] == 'ammo_carrier'
    )
    checks['two_soldiers_from_existing_roster_can_assault'] = (
        sum(bool(x.get('can_assault_other_vehicle')) for x in members) == 2
        and all(
            x['role'] == 'internal_soldier'
            for x in members if x.get('can_assault_other_vehicle')
        )
    )
    checks['plaza_and_invasion_assignments_match'] = (
        r['enemy_interior']['plaza_guard_npc_ids'] == ['E25', 'E26', 'E27']
        and r['enemy_interior']['invasion_npc_ids'] == ['E29', 'E30']
        and all(x.get('can_guard_plaza') for x in members if x['id'] in {'E25', 'E26', 'E27'})
    )
    checks['equipment_restore_not_npc_respawn'] = all(
        x['equipment_restore_ticks'] == 480 != expected_ticks for x in turrets
    )
    checks['turret_queue_limits_match'] = all(
        x['queue_capacity'] == r['cannon']['team_profiles']['enemy']['queue_capacity_per_turret']
        for x in turrets
    )
    checks['launch_budget_vehicle_not_turret'] = (
        r['cannon']['team_profiles']['enemy']['vehicle_launch_cooldown_ticks'] == 48
        and r['cannon']['team_profiles']['enemy']['scheduling'] == 'round_robin_ready_turrets'
        and not r['cannon']['team_profiles']['enemy']['bank_unused_launch_slots']
    )
    checks['supply_ports_match_four_depots'] = (
        len(layout['supply_ports']) == r['supply']['ports'] == 4
        and player_cannon['supply_ports'] == 4
        and {x['room_id'] for x in layout['supply_ports']}
        == {'ammo_a', 'ammo_b', 'ammo_c', 'ammo_d'}
    )

    nodes = room_ids | set(layout['corridor_nodes'])
    edges = layout['links']
    gates = r['gates']['ordered_ids']
    linked_gates = [x['gate_id'] for x in edges if x['gate_id']]
    checks['graph_references_valid'] = all(
        x['a'] in nodes and x['b'] in nodes
        and (x['gate_id'] is None or x['gate_id'] in gates)
        for x in edges
    )
    checks['seven_unique_gate_edges'] = (
        len(gates) == len(linked_gates) == 7 and set(gates) == set(linked_gates)
    )

    def reachable(start, closed):
        graph = defaultdict(list)
        for edge in edges:
            if edge['gate_id'] in closed:
                continue
            graph[edge['a']].append(edge['b'])
            graph[edge['b']].append(edge['a'])
        seen = {start}
        todo = [start]
        while todo:
            node = todo.pop()
            for nxt in graph[node]:
                if nxt not in seen:
                    seen.add(nxt)
                    todo.append(nxt)
        return seen

    route_start = 'central_corridor'
    checks['all_work_rooms_accessible_without_breaking_parts'] = (
        ordinary <= reachable(route_start, set(gates))
    )
    checks['each_single_closed_gate_blocks_all_origins'] = all(
        'core' not in reachable(origin, {gate})
        for origin in ordinary for gate in gates
    )
    checks['all_open_gives_core_route'] = all(
        'core' in reachable(origin, set()) for origin in ordinary
    )
    checks['gate_prefix_only_reaches_core_at_seven'] = all(
        ('core' in reachable(route_start, set(gates[k:]))) == (k == 7)
        for k in range(8)
    )

    parts = r['exterior']['parts']
    checks['seven_distinct_parts'] = len(parts) == len({x['id'] for x in parts}) == 7
    checks['part_health_aggregate_match'] = (
        sum(x['max_health'] for x in parts)
        == r['exterior']['aggregate_max_health_for_display']
    )
    checks['core_one_hit_unchanged'] = (
        r['objective']['valid_hits_to_lose'] == 1
        and not r['objective']['hold_work_required']
        and r['objective']['requires_all_7_gates_open_at_tick_start']
    )
    checks['same_victory_conditions_for_both_sides'] = r['user_confirmed_requirements']['same_victory_conditions_for_both_teams']
    checks['no_kill_count_gate'] = not r['enemy_interior']['additional_kill_requirement_for_gates_or_victory']
    checks['world_preservation_explicit'] = set(
        ['exterior', 'gates', 'core', 'equipment', 'queues', 'supply_order', 'repair_budget']
    ) <= set(r['respawn']['preserve_world'])
    checks['screen_flow_states_present'] = (
        r['screen_flow']['states']
        == ['home', 'name_entry', 'countdown', 'battle_player', 'battle_plaza', 'battle_enemy', 'spectator', 'result']
        and r['screen_flow']['countdown_ticks'] == 180
        and r['screen_flow']['name_length_min'] == 1
        and r['screen_flow']['name_length_max'] == 20
        and r['screen_flow']['area_transition_preserves_world']
    )
    checks['initial_result_and_ranking_required'] = (
        r['results']['ranking_initial_public_required']
        and 'ranking_top_10' in r['results']['required_initial_release_sections']
        and 'score_detail' in r['results']['required_initial_release_sections']
        and 'experiment_link' in r['results']['required_initial_release_sections']
    )
    cases = data['ORIGINAL_CASES.json']
    entries = cases.get('cases', cases.get('items', [])) if isinstance(cases, dict) else cases
    checks['eight_original_cases'] = len(entries) == 8
    checks['ruleset_bumped'] = r['ruleset_id'] == 'semekome-prototype-0.4-facing-castles'
    checks['ranking_plan_is_unconnected_null'] = (
        data['RANKING_INTEGRATION_PLAN.json']['status'] == 'unconnected_null_configuration'
        and data['RANKING_INTEGRATION_PLAN.json']['connection']['game_slug'] is None
        and data['RANKING_INTEGRATION_PLAN.json']['connection']['game_id'] is None
    )
    checks['score_plan_is_proposal'] = (
        data['SCORE_PLAN.json']['status'] == 'proposal_not_approved'
        and data['SCORE_PLAN.json']['required_for_initial_public_release']
    )
    checks['no_old_game_data_or_font_files'] = not any(
        p.name in ['AMMO_CANDIDATES.json', 'CREW_CANDIDATES.json']
        or p.suffix.lower() in ['.ttf', '.otf', '.ttc', '.woff', '.woff2']
        for p in root.rglob('*') if p.is_file()
    )

    result = {
        'document_version': '5.0',
        'checked_at': date.today().isoformat(),
        'scope_ja': '第5版の設計資料の構造・参照・人数・更新数・配置座標・部屋接続・画面/結果計画のみを検査。実ゲームの行動・床判定・性能・接続は検査しない。',
        'document_checks': checks,
        'counts': {
            'requirements': len(q),
            'planned_tests': len(tests),
            'enemy_npc_slots': len(members),
            'non_core_rooms_proposal': len(ordinary),
            'turrets_proposal': len(turrets),
            'supply_ports_proposal': len(layout['supply_ports']),
            'case_catalog': len(entries),
        },
        'not_performed': [
            'game_implementation',
            'game_acceptance_tests',
            'geometry_collision_test',
            'iphone_device_test',
            'human_playtest',
            'performance_measurement',
            'v5_pdf_visual_check',
            'ranking_connection_and_registration',
            'new_external_legal_research',
            'trademark_patent_or_final_assets_clearance',
        ],
    }
    old = root / 'DOCUMENT_CHECKS.json'
    if old.exists():
        previous = json.loads(old.read_text(encoding='utf-8'))
        # Keep the v4 PDF evidence as provenance without presenting it as a
        # fresh check of the v5 text and SVG.
        for key in ['pdf_visual_check', 'pdf_page_count']:
            if key in previous:
                result[f'previous_v4_{key}'] = previous[key]
    if args.write_report:
        old.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    failed = [k for k, v in checks.items() if not v]
    print(json.dumps({
        'document_checks': len(checks),
        'passed': len(checks) - len(failed),
        'failed': failed,
        'counts': result['counts'],
        'write_report': args.write_report,
    }, ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f'Document validation failed: {exc}', file=sys.stderr)
        sys.exit(2)
