#!/usr/bin/env python3
"""Validate design data only. Does not execute or certify the game."""
from pathlib import Path
from collections import Counter, defaultdict
import json, re, sys

def main() -> int:
    root=Path(__file__).resolve().parent
    checks={}
    data={p.name:json.loads(p.read_text(encoding='utf-8')) for p in root.glob('*.json') if p.name!='DOCUMENT_CHECKS.json'}
    checks['all_json_parse']=True
    r=data['INITIAL_RULES.json']; q=data['REQUIREMENTS.json']['requirements']; tests=data['ACCEPTANCE_TESTS.json']['tests']
    roster=data['ENEMY_ROSTER.json']; members=roster['members']; layout=data['INTERIOR_LAYOUTS.json']
    req_ids=[x['id'] for x in q]; test_ids=[x['id'] for x in tests]
    coverage={i for t in tests for i in t['requirement_ids']}
    checks['unique_requirement_ids']=len(req_ids)==len(set(req_ids))
    checks['unique_test_ids']=len(test_ids)==len(set(test_ids))
    checks['all_test_references_exist']=coverage<=set(req_ids)
    checks['all_requirements_have_planned_tests']=set(req_ids)<=coverage
    checks['no_game_test_claimed_run']=all(x['execution_status']=='not_run' for x in tests)
    main_text=(root/'PRODUCT_REQUIREMENTS.md').read_text(encoding='utf-8')
    checks['main_counts_match']=f'{len(q)}件の要件' in main_text and f'{len(tests)}件の検査' in main_text
    checks['markdown_requirement_refs_exist']=all(x in req_ids for p in root.glob('*.md') for x in re.findall(r'REQ-\d{2}',p.read_text(encoding='utf-8')))
    checks['enemy_roster_exactly_30']=len(members)==30==r['team_profiles']['enemy']['total_npc_slots']==roster['enemy_npc_slots']
    checks['unique_npc_ids']=len({x['id'] for x in members})==30
    checks['no_extra_commander']=r['team_profiles']['enemy']['extra_commander_slots']==0 and all(not x['extra_slot'] for x in members)
    checks['role_counts_match']=dict(Counter(x['role'] for x in members))==roster['role_counts']==r['enemy_interior']['role_counts']
    checks['four_roles_all_present']=set(roster['role_counts'])=={'shooter','shooter_guard','ammo_carrier','internal_soldier'}
    expected_ticks=r['simulation']['ticks_per_second']*20
    checks['respawn_20_seconds']=expected_ticks==1200==r['team_profiles']['enemy']['respawn_ticks'] and r['team_profiles']['enemy']['respawn_seconds']==20 and all(x['respawn_ticks']==1200 for x in members)
    checks['confirmed_count_and_delay_separate_from_proposals']=r['user_confirmed_requirements']['enemy_npc_slots']==30 and r['user_confirmed_requirements']['enemy_npc_respawn_seconds']==20 and 'turrets' not in r['user_confirmed_requirements']
    checks['no_shared_old_respawn_default']='respawn_ticks' not in r['actor'] and 'team' not in r
    checks['player_scope_preserved']=r['team_profiles']['player']['total_actors']==3 and r['team_profiles']['player']['respawn_ticks']==300 and 'unconfirmed' in r['team_profiles']['player']['basis']
    room_ids={x['id'] for x in layout['rooms']}; ordinary={x['id'] for x in layout['rooms'] if x['kind']!='core'}
    checks['room_counts_match']=len(room_ids)==8 and len(ordinary)==7==r['enemy_interior']['non_core_rooms']
    checks['all_home_initial_respawn_rooms_ordinary']=all(x[k] in ordinary for x in members for k in ['home_room_id','initial_room_id','respawn_room_id'])
    pads={p['id']:(room['id'],p['assigned_npc_id']) for room in layout['rooms'] for p in room['recovery_pads']}
    checks['thirty_dedicated_home_pads']=len(pads)==30 and all(pads.get(m['respawn_pad_id'])==(m['home_room_id'],m['id']) for m in members)
    checks['no_core_spawn_pads']=not next(x for x in layout['rooms'] if x['id']=='core')['recovery_pads']
    checks['room_headcounts_match']=dict(Counter(x['home_room_id'] for x in members))=={'entry':4,'ammo_a':4,'ammo_b':4,'battery_a':4,'battery_b':4,'battery_c':4,'security':6}
    turrets=layout['turrets']; by_id={x['id']:x for x in members}; turret_ids={x['id'] for x in turrets}
    checks['six_distinct_equipment_turrets']=len(turrets)==len(turret_ids)==6 and all(not x['counts_as_npc'] for x in turrets)
    checks['turret_shooter_bijection']=len({x['operator_npc_id'] for x in turrets})==6 and all(by_id[x['operator_npc_id']]['role']=='shooter' and by_id[x['operator_npc_id']]['turret_id']==x['id'] and by_id[x['operator_npc_id']]['home_room_id']==x['room_id'] for x in turrets)
    checks['guard_references_match']=all(m['guarded_turret_id'] in turret_ids and by_id[m['guarded_npc_id']]['role']=='shooter' and by_id[m['guarded_npc_id']]['home_room_id']==m['home_room_id'] for m in members if m['role']=='shooter_guard')
    checks['carrier_destinations_exist']=all(set(m['delivery_turret_ids'])<=turret_ids for m in members if m['role']=='ammo_carrier')
    checks['two_soldiers_from_existing_roster_can_assault']=sum(bool(x.get('can_assault_other_vehicle')) for x in members)==2 and all(x['role']=='internal_soldier' for x in members if x.get('can_assault_other_vehicle'))
    checks['equipment_restore_not_npc_respawn']=all(x['equipment_restore_ticks']==480!=expected_ticks for x in turrets)
    checks['turret_queue_limits_match']=all(x['queue_capacity']==r['cannon']['team_profiles']['enemy']['queue_capacity_per_turret'] for x in turrets)
    checks['launch_budget_vehicle_not_turret']=r['cannon']['team_profiles']['enemy']['vehicle_launch_cooldown_ticks']==48 and r['cannon']['team_profiles']['enemy']['scheduling']=='round_robin_ready_turrets' and not r['cannon']['team_profiles']['enemy']['bank_unused_launch_slots']
    checks['supply_ports_still_two']=len(layout['supply_ports'])==r['supply']['ports']==2
    nodes=room_ids|set(layout['corridor_nodes']); edges=layout['links']
    gates=r['gates']['ordered_ids']; linked_gates=[x['gate_id'] for x in edges if x['gate_id']]
    checks['graph_references_valid']=all(x['a'] in nodes and x['b'] in nodes and (x['gate_id'] is None or x['gate_id'] in gates) for x in edges)
    checks['seven_unique_gate_edges']=len(gates)==len(linked_gates)==7 and set(gates)==set(linked_gates)
    def reachable(start, closed):
        graph=defaultdict(list)
        for edge in edges:
            if edge['gate_id'] in closed:continue
            graph[edge['a']].append(edge['b']);graph[edge['b']].append(edge['a'])
        seen={start};todo=[start]
        while todo:
            node=todo.pop()
            for n in graph[node]:
                if n not in seen:seen.add(n);todo.append(n)
        return seen
    checks['all_work_rooms_accessible_without_breaking_parts']=ordinary<=reachable('entry',set(gates))
    checks['each_single_closed_gate_blocks_all_origins']=all('core' not in reachable(origin,{gate}) for origin in ordinary for gate in gates)
    checks['all_open_gives_core_route']=all('core' in reachable(origin,set()) for origin in ordinary)
    checks['gate_prefix_only_reaches_core_at_seven']=all(('core' in reachable('entry',set(gates[k:])))==(k==7) for k in range(8))
    parts=r['exterior']['parts']
    checks['seven_distinct_parts']=len(parts)==len({x['id'] for x in parts})==7
    checks['part_health_aggregate_match']=sum(x['max_health'] for x in parts)==r['exterior']['aggregate_max_health_for_display']
    checks['core_one_hit_unchanged']=r['objective']['valid_hits_to_lose']==1 and not r['objective']['hold_work_required'] and r['objective']['requires_all_7_gates_open_at_tick_start']
    checks['same_victory_conditions_for_both_sides']=r['user_confirmed_requirements']['same_victory_conditions_for_both_teams']
    checks['no_kill_count_gate']=not r['enemy_interior']['additional_kill_requirement_for_gates_or_victory']
    checks['world_preservation_explicit']=set(['exterior','gates','core','equipment','queues','supply_order','repair_budget'])<=set(r['respawn']['preserve_world'])
    cases=data['ORIGINAL_CASES.json']
    entries=cases.get('cases',cases.get('items',[])) if isinstance(cases,dict) else cases
    checks['eight_original_cases']=len(entries)==8
    checks['ruleset_bumped']=r['ruleset_id']=='workshop-tank-prototype-0.3-npc30'
    checks['no_old_game_data_or_font_files']=not any(p.name in ['AMMO_CANDIDATES.json','CREW_CANDIDATES.json'] or p.suffix.lower() in ['.ttf','.otf','.ttc','.woff','.woff2'] for p in root.rglob('*') if p.is_file())
    result={'document_version':'4.0','checked_at':'2026-09-09','scope_ja':'設計資料の構造・参照・人数・更新数・部屋接続のみを実際に検査。実ゲームの行動・床判定・性能は検査しない。','document_checks':checks,'counts':{'requirements':len(q),'planned_tests':len(tests),'enemy_npc_slots':len(members),'non_core_rooms_proposal':len(ordinary),'turrets_proposal':len(turrets),'case_catalog':len(entries)},'not_performed':['game_implementation','game_acceptance_tests','geometry_collision_test','iphone_device_test','human_playtest','performance_measurement','new_external_legal_research','trademark_patent_or_final_assets_clearance']}
    old=root/'DOCUMENT_CHECKS.json'
    if old.exists():
        previous=json.loads(old.read_text(encoding='utf-8'))
        for key in ['pdf_visual_check','pdf_page_count']:
            if key in previous:result[key]=previous[key]
    old.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    failed=[k for k,v in checks.items() if not v]
    print(json.dumps({'document_checks':len(checks),'passed':len(checks)-len(failed),'failed':failed,'counts':result['counts']},ensure_ascii=False,indent=2))
    return 1 if failed else 0
if __name__=='__main__':
    try:sys.exit(main())
    except (OSError,ValueError,KeyError,TypeError) as e:
        print(f'Document validation failed: {e}',file=sys.stderr);sys.exit(2)
