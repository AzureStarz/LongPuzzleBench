import type { TruckEscape2ReferenceMove, TruckEscape2ReferenceSolution } from '../analytics/TruckEscape2AbilityTypes';
/**
 * Canonical shortest solutions verified by breadth-first search against
 * TruckEscape2BoardModel. Regenerate with tools/generate_truck_escape_2_references.mjs
 * whenever a level definition or move rule changes.
 */
const ENCODED_REFERENCE_SOLUTIONS: Record<string, {
    moves: TruckEscape2ReferenceMove[];
    states: string[];
}> = {
    "truck_escape_2_easy_1": {
        "moves": [
            {
                "vehicleId": "sand_semi",
                "delta": -1
            },
            {
                "vehicleId": "cream_coupe",
                "delta": -2
            },
            {
                "vehicleId": "blue_sedan",
                "delta": -2
            },
            {
                "vehicleId": "red_target",
                "delta": 2
            }
        ],
        "states": [
            "0,1|1,2|2,1|2,3|4,0|4,3",
            "0,0|1,2|2,1|2,3|4,0|4,3",
            "0,0|1,0|2,1|2,3|4,0|4,3",
            "0,0|1,0|2,1|0,3|4,0|4,3",
            "0,0|1,0|2,3|0,3|4,0|4,3"
        ]
    },
    "truck_escape_2_easy_2": {
        "moves": [
            {
                "vehicleId": "e2_blue_left",
                "delta": -1
            },
            {
                "vehicleId": "e2_blue_right",
                "delta": -1
            },
            {
                "vehicleId": "e2_white_bottom",
                "delta": -2
            },
            {
                "vehicleId": "e2_white_middle",
                "delta": 1
            },
            {
                "vehicleId": "e2_red_target",
                "delta": 3
            }
        ],
        "states": [
            "2,0|1,2|0,3|2,3|1,4|4,2",
            "2,0|0,2|0,3|2,3|1,4|4,2",
            "2,0|0,2|0,3|2,3|0,4|4,2",
            "2,0|0,2|0,3|2,3|0,4|4,0",
            "2,0|0,2|0,3|3,3|0,4|4,0",
            "2,3|0,2|0,3|3,3|0,4|4,0"
        ]
    },
    "truck_escape_2_easy_3": {
        "moves": [
            {
                "vehicleId": "e3_white_left",
                "delta": 1
            },
            {
                "vehicleId": "e3_purple_top",
                "delta": -2
            },
            {
                "vehicleId": "e3_blue_middle",
                "delta": -2
            },
            {
                "vehicleId": "e3_red_target",
                "delta": 3
            }
        ],
        "states": [
            "0,0|0,2|1,4|2,1|2,3|3,0",
            "1,0|0,2|1,4|2,1|2,3|3,0",
            "1,0|0,0|1,4|2,1|2,3|3,0",
            "1,0|0,0|1,4|2,1|0,3|3,0",
            "1,0|0,0|1,4|2,4|0,3|3,0"
        ]
    },
    "truck_escape_2_easy_4": {
        "moves": [
            {
                "vehicleId": "e4_blue_left_top",
                "delta": -1
            },
            {
                "vehicleId": "e4_blue_left_bottom",
                "delta": -1
            },
            {
                "vehicleId": "e4_pickup_left",
                "delta": -1
            },
            {
                "vehicleId": "e4_pickup_right",
                "delta": -1
            },
            {
                "vehicleId": "e4_white_mid_right",
                "delta": 1
            },
            {
                "vehicleId": "e4_red_target",
                "delta": 1
            }
        ],
        "states": [
            "1,0|3,0|0,1|2,1|2,2|0,4|2,4|4,1|4,3",
            "0,0|3,0|0,1|2,1|2,2|0,4|2,4|4,1|4,3",
            "0,0|2,0|0,1|2,1|2,2|0,4|2,4|4,1|4,3",
            "0,0|2,0|0,1|2,1|2,2|0,4|2,4|4,0|4,3",
            "0,0|2,0|0,1|2,1|2,2|0,4|2,4|4,0|4,2",
            "0,0|2,0|0,1|2,1|2,2|0,4|3,4|4,0|4,2",
            "0,0|2,0|0,1|2,1|2,3|0,4|3,4|4,0|4,2"
        ]
    },
    "truck_escape_2_easy_5": {
        "moves": [
            {
                "vehicleId": "e5_white_right",
                "delta": -1
            },
            {
                "vehicleId": "e5_sand_pickup",
                "delta": -2
            },
            {
                "vehicleId": "e5_sand_bottom",
                "delta": -1
            },
            {
                "vehicleId": "e5_purple_gate",
                "delta": 2
            },
            {
                "vehicleId": "e5_red_target",
                "delta": 2
            }
        ],
        "states": [
            "2,1|1,3|1,4|4,2|5,1",
            "2,1|1,3|0,4|4,2|5,1",
            "2,1|1,3|0,4|4,0|5,1",
            "2,1|1,3|0,4|4,0|5,0",
            "2,1|3,3|0,4|4,0|5,0",
            "2,3|3,3|0,4|4,0|5,0"
        ]
    },
    "truck_escape_2_easy_6": {
        "moves": [
            {
                "vehicleId": "e6_red_target",
                "delta": -1
            },
            {
                "vehicleId": "e6_white_top",
                "delta": 1
            },
            {
                "vehicleId": "e6_white_coupe",
                "delta": -3
            },
            {
                "vehicleId": "e6_white_top",
                "delta": -1
            },
            {
                "vehicleId": "e6_blue_top",
                "delta": -1
            },
            {
                "vehicleId": "e6_red_target",
                "delta": 3
            }
        ],
        "states": [
            "0,2|0,3|2,1|1,3|3,3",
            "0,2|0,3|2,0|1,3|3,3",
            "1,2|0,3|2,0|1,3|3,3",
            "1,2|0,0|2,0|1,3|3,3",
            "0,2|0,0|2,0|1,3|3,3",
            "0,2|0,0|2,0|0,3|3,3",
            "0,2|0,0|2,3|0,3|3,3"
        ]
    },
    "truck_escape_2_easy_7": {
        "moves": [
            {
                "vehicleId": "e7_red_target",
                "delta": -1
            },
            {
                "vehicleId": "e7_bus_bottom",
                "delta": -3
            },
            {
                "vehicleId": "e7_pickup",
                "delta": -3
            },
            {
                "vehicleId": "e7_bus_right",
                "delta": 3
            },
            {
                "vehicleId": "e7_bus_bottom",
                "delta": 3
            },
            {
                "vehicleId": "e7_red_target",
                "delta": 3
            }
        ],
        "states": [
            "2,1|0,4|3,2|3,3",
            "2,0|0,4|3,2|3,3",
            "2,0|0,4|0,2|3,3",
            "2,0|0,4|0,2|3,0",
            "2,0|3,4|0,2|3,0",
            "2,0|3,4|3,2|3,0",
            "2,3|3,4|3,2|3,0"
        ]
    },
    "truck_escape_2_easy_8": {
        "moves": [
            {
                "vehicleId": "e8_purple_left_bus",
                "delta": 1
            },
            {
                "vehicleId": "e8_pickup_top_left",
                "delta": -1
            },
            {
                "vehicleId": "e8_pickup_top_right",
                "delta": -1
            },
            {
                "vehicleId": "e8_white_right",
                "delta": -1
            },
            {
                "vehicleId": "e8_red_target",
                "delta": 1
            }
        ],
        "states": [
            "0,0|0,1|0,2|0,4|1,2|1,5|2,2|2,3|3,5|4,0|4,3|5,0",
            "0,0|1,1|0,2|0,4|1,2|1,5|2,2|2,3|3,5|4,0|4,3|5,0",
            "0,0|1,1|0,1|0,4|1,2|1,5|2,2|2,3|3,5|4,0|4,3|5,0",
            "0,0|1,1|0,1|0,3|1,2|1,5|2,2|2,3|3,5|4,0|4,3|5,0",
            "0,0|1,1|0,1|0,3|1,2|0,5|2,2|2,3|3,5|4,0|4,3|5,0",
            "0,0|1,1|0,1|0,3|1,2|0,5|2,2|2,4|3,5|4,0|4,3|5,0"
        ]
    },
    "truck_escape_2_easy_9": {
        "moves": [
            {
                "vehicleId": "e9_red_target",
                "delta": -1
            },
            {
                "vehicleId": "e9_blue_top",
                "delta": 1
            },
            {
                "vehicleId": "e9_white_coupe",
                "delta": -3
            },
            {
                "vehicleId": "e9_blue_top",
                "delta": -1
            },
            {
                "vehicleId": "e9_white_middle",
                "delta": -1
            },
            {
                "vehicleId": "e9_red_target",
                "delta": 3
            }
        ],
        "states": [
            "0,2|0,3|2,1|1,3|3,3|5,0",
            "0,2|0,3|2,0|1,3|3,3|5,0",
            "1,2|0,3|2,0|1,3|3,3|5,0",
            "1,2|0,0|2,0|1,3|3,3|5,0",
            "0,2|0,0|2,0|1,3|3,3|5,0",
            "0,2|0,0|2,0|0,3|3,3|5,0",
            "0,2|0,0|2,3|0,3|3,3|5,0"
        ]
    },
    "truck_escape_2_easy_10": {
        "moves": [
            {
                "vehicleId": "e10_purple_top",
                "delta": -3
            },
            {
                "vehicleId": "e10_white_right",
                "delta": -1
            },
            {
                "vehicleId": "e10_white_pickup",
                "delta": -1
            },
            {
                "vehicleId": "e10_purple_middle",
                "delta": 1
            },
            {
                "vehicleId": "e10_red_target",
                "delta": 4
            }
        ],
        "states": [
            "0,3|1,0|2,0|2,2|1,5|3,4|4,1|4,3",
            "0,0|1,0|2,0|2,2|1,5|3,4|4,1|4,3",
            "0,0|1,0|2,0|2,2|0,5|3,4|4,1|4,3",
            "0,0|1,0|2,0|2,2|0,5|3,4|4,0|4,3",
            "0,0|1,0|2,0|3,2|0,5|3,4|4,0|4,3",
            "0,0|1,0|2,4|3,2|0,5|3,4|4,0|4,3"
        ]
    },
    "truck_escape_2_hard_1": {
        "moves": [
            {
                "vehicleId": "m1_sand_bus",
                "delta": -2
            },
            {
                "vehicleId": "m1_sand_pickup",
                "delta": 2
            },
            {
                "vehicleId": "m1_blue_middle",
                "delta": 2
            },
            {
                "vehicleId": "m1_red_target",
                "delta": 1
            },
            {
                "vehicleId": "m1_white_coupe",
                "delta": 1
            },
            {
                "vehicleId": "m1_blue_left",
                "delta": -4
            },
            {
                "vehicleId": "m1_red_target",
                "delta": -1
            },
            {
                "vehicleId": "m1_white_coupe",
                "delta": -1
            },
            {
                "vehicleId": "m1_blue_middle",
                "delta": -2
            },
            {
                "vehicleId": "m1_sand_pickup",
                "delta": -3
            },
            {
                "vehicleId": "m1_blue_middle",
                "delta": 1
            },
            {
                "vehicleId": "m1_sand_bus",
                "delta": 3
            },
            {
                "vehicleId": "m1_red_target",
                "delta": 3
            }
        ],
        "states": [
            "0,2|2,0|2,2|2,3|3,0|4,0|4,1",
            "0,2|2,0|2,2|0,3|3,0|4,0|4,1",
            "0,2|2,0|2,2|0,3|3,0|4,0|4,3",
            "0,2|2,0|4,2|0,3|3,0|4,0|4,3",
            "0,2|2,1|4,2|0,3|3,0|4,0|4,3",
            "0,2|2,1|4,2|0,3|3,1|4,0|4,3",
            "0,2|2,1|4,2|0,3|3,1|0,0|4,3",
            "0,2|2,0|4,2|0,3|3,1|0,0|4,3",
            "0,2|2,0|4,2|0,3|3,0|0,0|4,3",
            "0,2|2,0|2,2|0,3|3,0|0,0|4,3",
            "0,2|2,0|2,2|0,3|3,0|0,0|4,0",
            "0,2|2,0|3,2|0,3|3,0|0,0|4,0",
            "0,2|2,0|3,2|3,3|3,0|0,0|4,0",
            "0,2|2,3|3,2|3,3|3,0|0,0|4,0"
        ]
    },
    "truck_escape_2_hard_2": {
        "moves": [
            {
                "vehicleId": "m2_red_target",
                "delta": -2
            },
            {
                "vehicleId": "m2_blue_middle",
                "delta": -1
            },
            {
                "vehicleId": "m2_sand_pickup",
                "delta": -4
            },
            {
                "vehicleId": "m2_white_pickup_bottom",
                "delta": 1
            },
            {
                "vehicleId": "m2_blue_middle",
                "delta": 2
            },
            {
                "vehicleId": "m2_white_coupe",
                "delta": -4
            },
            {
                "vehicleId": "m2_blue_middle",
                "delta": -1
            },
            {
                "vehicleId": "m2_white_pickup_bottom",
                "delta": -2
            },
            {
                "vehicleId": "m2_purple_bus",
                "delta": 3
            },
            {
                "vehicleId": "m2_red_target",
                "delta": 4
            }
        ],
        "states": [
            "1,0|1,3|0,5|2,2|3,3|3,4|4,4|5,0|5,3",
            "1,0|1,3|0,5|2,0|3,3|3,4|4,4|5,0|5,3",
            "1,0|1,3|0,5|2,0|2,3|3,4|4,4|5,0|5,3",
            "1,0|1,3|0,5|2,0|2,3|3,4|4,0|5,0|5,3",
            "1,0|1,3|0,5|2,0|2,3|3,4|4,0|5,0|5,4",
            "1,0|1,3|0,5|2,0|4,3|3,4|4,0|5,0|5,4",
            "1,0|1,3|0,5|2,0|4,3|3,0|4,0|5,0|5,4",
            "1,0|1,3|0,5|2,0|3,3|3,0|4,0|5,0|5,4",
            "1,0|1,3|0,5|2,0|3,3|3,0|4,0|5,0|5,2",
            "1,0|1,3|3,5|2,0|3,3|3,0|4,0|5,0|5,2",
            "1,0|1,3|3,5|2,4|3,3|3,0|4,0|5,0|5,2"
        ]
    },
    "truck_escape_2_hard_3": {
        "moves": [
            {
                "vehicleId": "m3_sand_bus_right",
                "delta": -1
            },
            {
                "vehicleId": "m3_sand_semi_middle",
                "delta": 1
            },
            {
                "vehicleId": "m3_blue_bottom",
                "delta": -1
            },
            {
                "vehicleId": "m3_white_bottom_left",
                "delta": 1
            },
            {
                "vehicleId": "m3_sand_bus_left",
                "delta": 1
            },
            {
                "vehicleId": "m3_sand_pickup",
                "delta": -1
            },
            {
                "vehicleId": "m3_blue_bottom",
                "delta": -3
            },
            {
                "vehicleId": "m3_sand_semi_middle",
                "delta": -2
            },
            {
                "vehicleId": "m3_sand_semi_bottom",
                "delta": -2
            },
            {
                "vehicleId": "m3_white_bottom_right",
                "delta": -1
            },
            {
                "vehicleId": "m3_sand_bus_right",
                "delta": 3
            },
            {
                "vehicleId": "m3_red_target",
                "delta": 1
            }
        ],
        "states": [
            "0,3|0,4|2,0|2,1|2,3|1,5|3,2|4,2|4,3|5,0|5,4",
            "0,3|0,4|2,0|2,1|2,3|0,5|3,2|4,2|4,3|5,0|5,4",
            "0,3|0,4|2,0|2,1|2,3|0,5|3,3|4,2|4,3|5,0|5,4",
            "0,3|0,4|2,0|2,1|2,3|0,5|3,3|3,2|4,3|5,0|5,4",
            "0,3|0,4|2,0|2,1|2,3|0,5|3,3|3,2|4,3|5,1|5,4",
            "0,3|0,4|3,0|2,1|2,3|0,5|3,3|3,2|4,3|5,1|5,4",
            "0,3|0,4|3,0|2,0|2,3|0,5|3,3|3,2|4,3|5,1|5,4",
            "0,3|0,4|3,0|2,0|2,3|0,5|3,3|0,2|4,3|5,1|5,4",
            "0,3|0,4|3,0|2,0|2,3|0,5|3,1|0,2|4,3|5,1|5,4",
            "0,3|0,4|3,0|2,0|2,3|0,5|3,1|0,2|4,1|5,1|5,4",
            "0,3|0,4|3,0|2,0|2,3|0,5|3,1|0,2|4,1|5,1|5,3",
            "0,3|0,4|3,0|2,0|2,3|3,5|3,1|0,2|4,1|5,1|5,3",
            "0,3|0,4|3,0|2,0|2,4|3,5|3,1|0,2|4,1|5,1|5,3"
        ]
    },
    "truck_escape_2_hard_4": {
        "moves": [
            {
                "vehicleId": "m4_sand_pickup_top",
                "delta": -1
            },
            {
                "vehicleId": "m4_white_left_top",
                "delta": -1
            },
            {
                "vehicleId": "m4_white_right_top",
                "delta": -1
            },
            {
                "vehicleId": "m4_white_left_bottom",
                "delta": -1
            },
            {
                "vehicleId": "m4_pickup_right_bottom",
                "delta": -3
            },
            {
                "vehicleId": "m4_pickup_bottom_right",
                "delta": 1
            },
            {
                "vehicleId": "m4_white_left_bottom",
                "delta": 2
            },
            {
                "vehicleId": "m4_pickup_right_top",
                "delta": -3
            },
            {
                "vehicleId": "m4_white_left_bottom",
                "delta": -1
            },
            {
                "vehicleId": "m4_pickup_bottom_right",
                "delta": -1
            },
            {
                "vehicleId": "m4_sand_bus",
                "delta": 3
            },
            {
                "vehicleId": "m4_red_target",
                "delta": 3
            }
        ],
        "states": [
            "0,1|0,4|1,2|1,3|2,0|3,2|3,3|4,3|5,0|5,2",
            "0,0|0,4|1,2|1,3|2,0|3,2|3,3|4,3|5,0|5,2",
            "0,0|0,4|0,2|1,3|2,0|3,2|3,3|4,3|5,0|5,2",
            "0,0|0,4|0,2|0,3|2,0|3,2|3,3|4,3|5,0|5,2",
            "0,0|0,4|0,2|0,3|2,0|2,2|3,3|4,3|5,0|5,2",
            "0,0|0,4|0,2|0,3|2,0|2,2|3,3|4,0|5,0|5,2",
            "0,0|0,4|0,2|0,3|2,0|2,2|3,3|4,0|5,0|5,3",
            "0,0|0,4|0,2|0,3|2,0|4,2|3,3|4,0|5,0|5,3",
            "0,0|0,4|0,2|0,3|2,0|4,2|3,0|4,0|5,0|5,3",
            "0,0|0,4|0,2|0,3|2,0|3,2|3,0|4,0|5,0|5,3",
            "0,0|0,4|0,2|0,3|2,0|3,2|3,0|4,0|5,0|5,2",
            "0,0|3,4|0,2|0,3|2,0|3,2|3,0|4,0|5,0|5,2",
            "0,0|3,4|0,2|0,3|2,3|3,2|3,0|4,0|5,0|5,2"
        ]
    },
    "truck_escape_2_hard_5": {
        "moves": [
            {
                "vehicleId": "m5_white_middle",
                "delta": -1
            },
            {
                "vehicleId": "m5_white_coupe",
                "delta": -2
            },
            {
                "vehicleId": "m5_sand_bus",
                "delta": 1
            },
            {
                "vehicleId": "m5_white_pickup_right",
                "delta": 2
            },
            {
                "vehicleId": "m5_white_middle",
                "delta": -1
            },
            {
                "vehicleId": "m5_red_target",
                "delta": 1
            },
            {
                "vehicleId": "m5_blue_left",
                "delta": -2
            },
            {
                "vehicleId": "m5_sand_semi",
                "delta": -2
            },
            {
                "vehicleId": "m5_sand_pickup",
                "delta": -3
            },
            {
                "vehicleId": "m5_sand_bus",
                "delta": 2
            },
            {
                "vehicleId": "m5_red_target",
                "delta": 2
            }
        ],
        "states": [
            "0,0|0,2|0,4|2,1|2,3|3,1|3,4|4,2|5,3",
            "0,0|0,2|0,4|2,1|1,3|3,1|3,4|4,2|5,3",
            "0,0|0,2|0,4|2,1|1,3|3,1|3,2|4,2|5,3",
            "0,0|0,2|1,4|2,1|1,3|3,1|3,2|4,2|5,3",
            "0,0|0,4|1,4|2,1|1,3|3,1|3,2|4,2|5,3",
            "0,0|0,4|1,4|2,1|0,3|3,1|3,2|4,2|5,3",
            "0,0|0,4|1,4|2,2|0,3|3,1|3,2|4,2|5,3",
            "0,0|0,4|1,4|2,2|0,3|1,1|3,2|4,2|5,3",
            "0,0|0,4|1,4|2,2|0,3|1,1|3,2|4,0|5,3",
            "0,0|0,4|1,4|2,2|0,3|1,1|3,2|4,0|5,0",
            "0,0|0,4|3,4|2,2|0,3|1,1|3,2|4,0|5,0",
            "0,0|0,4|3,4|2,4|0,3|1,1|3,2|4,0|5,0"
        ]
    },
    "truck_escape_2_hard_6": {
        "moves": [
            {
                "vehicleId": "m6_blue_right",
                "delta": -1
            },
            {
                "vehicleId": "m6_red_target",
                "delta": 1
            },
            {
                "vehicleId": "m6_blue_left",
                "delta": -2
            },
            {
                "vehicleId": "m6_white_coupe_middle",
                "delta": -1
            },
            {
                "vehicleId": "m6_white_bottom",
                "delta": -1
            },
            {
                "vehicleId": "m6_white_coupe_bottom",
                "delta": 3
            },
            {
                "vehicleId": "m6_white_bottom",
                "delta": 1
            },
            {
                "vehicleId": "m6_white_coupe_middle",
                "delta": 1
            },
            {
                "vehicleId": "m6_blue_left",
                "delta": 3
            },
            {
                "vehicleId": "m6_red_target",
                "delta": -1
            },
            {
                "vehicleId": "m6_white_coupe_middle",
                "delta": -1
            },
            {
                "vehicleId": "m6_white_bottom",
                "delta": -4
            },
            {
                "vehicleId": "m6_sand_pickup",
                "delta": -2
            },
            {
                "vehicleId": "m6_blue_middle",
                "delta": 1
            },
            {
                "vehicleId": "m6_red_target",
                "delta": 3
            }
        ],
        "states": [
            "0,3|1,4|2,0|2,3|3,0|3,1|4,2|4,3|5,0",
            "0,3|0,4|2,0|2,3|3,0|3,1|4,2|4,3|5,0",
            "0,3|0,4|2,1|2,3|3,0|3,1|4,2|4,3|5,0",
            "0,3|0,4|2,1|2,3|1,0|3,1|4,2|4,3|5,0",
            "0,3|0,4|2,1|2,3|1,0|3,0|4,2|4,3|5,0",
            "0,3|0,4|2,1|2,3|1,0|3,0|3,2|4,3|5,0",
            "0,3|0,4|2,1|2,3|1,0|3,0|3,2|4,3|5,3",
            "0,3|0,4|2,1|2,3|1,0|3,0|4,2|4,3|5,3",
            "0,3|0,4|2,1|2,3|1,0|3,1|4,2|4,3|5,3",
            "0,3|0,4|2,1|2,3|4,0|3,1|4,2|4,3|5,3",
            "0,3|0,4|2,0|2,3|4,0|3,1|4,2|4,3|5,3",
            "0,3|0,4|2,0|2,3|4,0|3,0|4,2|4,3|5,3",
            "0,3|0,4|2,0|2,3|4,0|3,0|0,2|4,3|5,3",
            "0,3|0,4|2,0|2,3|4,0|3,0|0,2|4,1|5,3",
            "0,3|0,4|2,0|3,3|4,0|3,0|0,2|4,1|5,3",
            "0,3|0,4|2,3|3,3|4,0|3,0|0,2|4,1|5,3"
        ]
    },
    "truck_escape_2_hard_7": {
        "moves": [
            {
                "vehicleId": "m7_sand_pickup",
                "delta": 1
            },
            {
                "vehicleId": "m7_white_bottom",
                "delta": -3
            },
            {
                "vehicleId": "m7_white_pickup",
                "delta": 3
            },
            {
                "vehicleId": "m7_white_bottom",
                "delta": 2
            },
            {
                "vehicleId": "m7_purple_semi",
                "delta": 3
            },
            {
                "vehicleId": "m7_sand_bus",
                "delta": 2
            },
            {
                "vehicleId": "m7_red_target",
                "delta": 5
            }
        ],
        "states": [
            "0,0|0,2|0,5|1,2|2,0|3,0|3,4|4,2|4,4|5,0",
            "0,0|0,2|0,5|1,2|2,0|3,0|3,5|4,2|4,4|5,0",
            "0,0|0,2|0,5|1,2|2,0|3,0|3,5|4,2|1,4|5,0",
            "0,0|0,2|0,5|1,2|2,0|3,0|3,5|4,5|1,4|5,0",
            "0,0|0,2|0,5|1,2|2,0|3,0|3,5|4,5|3,4|5,0",
            "0,0|0,2|0,5|1,2|2,0|3,0|3,5|4,5|3,4|5,3",
            "0,0|0,2|0,5|3,2|2,0|3,0|3,5|4,5|3,4|5,3",
            "0,0|0,2|0,5|3,2|2,5|3,0|3,5|4,5|3,4|5,3"
        ]
    },
    "truck_escape_2_hard_8": {
        "moves": [
            {
                "vehicleId": "m8_white_top",
                "delta": -1
            },
            {
                "vehicleId": "m8_blue_right",
                "delta": -1
            },
            {
                "vehicleId": "m8_white_right",
                "delta": -1
            },
            {
                "vehicleId": "m8_sand_pickup",
                "delta": 1
            },
            {
                "vehicleId": "m8_blue_middle",
                "delta": 1
            },
            {
                "vehicleId": "m8_red_target",
                "delta": 2
            },
            {
                "vehicleId": "m8_blue_left",
                "delta": -3
            },
            {
                "vehicleId": "m8_white_left",
                "delta": -3
            },
            {
                "vehicleId": "m8_red_target",
                "delta": -2
            },
            {
                "vehicleId": "m8_blue_middle",
                "delta": -1
            },
            {
                "vehicleId": "m8_sand_pickup",
                "delta": -3
            },
            {
                "vehicleId": "m8_blue_middle",
                "delta": 1
            },
            {
                "vehicleId": "m8_white_right",
                "delta": 1
            },
            {
                "vehicleId": "m8_red_target",
                "delta": 3
            }
        ],
        "states": [
            "0,2|1,3|1,4|2,0|2,2|3,0|3,1|3,4|4,2",
            "0,2|0,3|1,4|2,0|2,2|3,0|3,1|3,4|4,2",
            "0,2|0,3|0,4|2,0|2,2|3,0|3,1|3,4|4,2",
            "0,2|0,3|0,4|2,0|2,2|3,0|3,1|2,4|4,2",
            "0,2|0,3|0,4|2,0|2,2|3,0|3,1|2,4|4,3",
            "0,2|0,3|0,4|2,0|3,2|3,0|3,1|2,4|4,3",
            "0,2|0,3|0,4|2,2|3,2|3,0|3,1|2,4|4,3",
            "0,2|0,3|0,4|2,2|3,2|0,0|3,1|2,4|4,3",
            "0,2|0,3|0,4|2,2|3,2|0,0|0,1|2,4|4,3",
            "0,2|0,3|0,4|2,0|3,2|0,0|0,1|2,4|4,3",
            "0,2|0,3|0,4|2,0|2,2|0,0|0,1|2,4|4,3",
            "0,2|0,3|0,4|2,0|2,2|0,0|0,1|2,4|4,0",
            "0,2|0,3|0,4|2,0|3,2|0,0|0,1|2,4|4,0",
            "0,2|0,3|0,4|2,0|3,2|0,0|0,1|3,4|4,0",
            "0,2|0,3|0,4|2,3|3,2|0,0|0,1|3,4|4,0"
        ]
    },
    "truck_escape_2_hard_9": {
        "moves": [
            {
                "vehicleId": "m9_sand_pickup",
                "delta": 1
            },
            {
                "vehicleId": "m9_purple_bus",
                "delta": 1
            },
            {
                "vehicleId": "m9_white_middle",
                "delta": -2
            },
            {
                "vehicleId": "m9_red_target",
                "delta": 2
            },
            {
                "vehicleId": "m9_blue_top_right",
                "delta": 3
            },
            {
                "vehicleId": "m9_red_target",
                "delta": -2
            },
            {
                "vehicleId": "m9_white_middle",
                "delta": 2
            },
            {
                "vehicleId": "m9_sand_pickup",
                "delta": -3
            },
            {
                "vehicleId": "m9_white_middle",
                "delta": -2
            },
            {
                "vehicleId": "m9_blue_right",
                "delta": -2
            },
            {
                "vehicleId": "m9_red_target",
                "delta": 4
            }
        ],
        "states": [
            "0,0|0,1|1,3|2,0|2,2|2,3|2,5|4,0|4,3",
            "0,0|0,1|1,4|2,0|2,2|2,3|2,5|4,0|4,3",
            "0,0|0,1|1,4|2,0|3,2|2,3|2,5|4,0|4,3",
            "0,0|0,1|1,4|2,0|3,2|0,3|2,5|4,0|4,3",
            "0,0|0,1|1,4|2,2|3,2|0,3|2,5|4,0|4,3",
            "0,0|3,1|1,4|2,2|3,2|0,3|2,5|4,0|4,3",
            "0,0|3,1|1,4|2,0|3,2|0,3|2,5|4,0|4,3",
            "0,0|3,1|1,4|2,0|3,2|2,3|2,5|4,0|4,3",
            "0,0|3,1|1,1|2,0|3,2|2,3|2,5|4,0|4,3",
            "0,0|3,1|1,1|2,0|3,2|0,3|2,5|4,0|4,3",
            "0,0|3,1|1,1|2,0|3,2|0,3|0,5|4,0|4,3",
            "0,0|3,1|1,1|2,4|3,2|0,3|0,5|4,0|4,3"
        ]
    },
    "truck_escape_2_hard_10": {
        "moves": [
            {
                "vehicleId": "m10_purple_left",
                "delta": -1
            },
            {
                "vehicleId": "m10_purple_right",
                "delta": -1
            },
            {
                "vehicleId": "m10_sand_pickup",
                "delta": 3
            },
            {
                "vehicleId": "m10_white_left",
                "delta": -1
            },
            {
                "vehicleId": "m10_white_pickup",
                "delta": -2
            },
            {
                "vehicleId": "m10_purple_left",
                "delta": 3
            },
            {
                "vehicleId": "m10_red_target",
                "delta": 1
            },
            {
                "vehicleId": "m10_white_left",
                "delta": -3
            },
            {
                "vehicleId": "m10_red_target",
                "delta": -1
            },
            {
                "vehicleId": "m10_purple_left",
                "delta": -3
            },
            {
                "vehicleId": "m10_sand_pickup",
                "delta": -3
            },
            {
                "vehicleId": "m10_purple_left",
                "delta": 3
            },
            {
                "vehicleId": "m10_purple_right",
                "delta": 3
            },
            {
                "vehicleId": "m10_red_target",
                "delta": 3
            }
        ],
        "states": [
            "1,2|1,4|2,0|3,0|4,0|5,2",
            "0,2|1,4|2,0|3,0|4,0|5,2",
            "0,2|0,4|2,0|3,0|4,0|5,2",
            "0,2|0,4|2,0|3,3|4,0|5,2",
            "0,2|0,4|2,0|3,3|3,0|5,2",
            "0,2|0,4|2,0|3,3|3,0|5,0",
            "3,2|0,4|2,0|3,3|3,0|5,0",
            "3,2|0,4|2,1|3,3|3,0|5,0",
            "3,2|0,4|2,1|3,3|0,0|5,0",
            "3,2|0,4|2,0|3,3|0,0|5,0",
            "0,2|0,4|2,0|3,3|0,0|5,0",
            "0,2|0,4|2,0|3,0|0,0|5,0",
            "3,2|0,4|2,0|3,0|0,0|5,0",
            "3,2|3,4|2,0|3,0|0,0|5,0",
            "3,2|3,4|2,3|3,0|0,0|5,0"
        ]
    },
    "truck_escape_2_medium_1": {
        "moves": [
            {
                "vehicleId": "h1_purple_bus",
                "delta": -2
            },
            {
                "vehicleId": "h1_sand_middle",
                "delta": -1
            },
            {
                "vehicleId": "h1_white_bottom",
                "delta": -2
            },
            {
                "vehicleId": "h1_cream_coupe",
                "delta": -2
            },
            {
                "vehicleId": "h1_sand_bus",
                "delta": 2
            },
            {
                "vehicleId": "h1_red_target",
                "delta": 4
            }
        ],
        "states": [
            "0,2|2,0|2,1|1,5|3,1|5,2|5,3|5,5",
            "0,2|0,0|2,1|1,5|3,1|5,2|5,3|5,5",
            "0,2|0,0|2,1|1,5|3,0|5,2|5,3|5,5",
            "0,2|0,0|2,1|1,5|3,0|5,2|3,3|5,5",
            "0,2|0,0|2,1|1,5|3,0|5,2|3,3|5,3",
            "0,2|0,0|2,1|3,5|3,0|5,2|3,3|5,3",
            "0,2|0,0|2,5|3,5|3,0|5,2|3,3|5,3"
        ]
    },
    "truck_escape_2_medium_2": {
        "moves": [
            {
                "vehicleId": "h2_white_coupe",
                "delta": -2
            },
            {
                "vehicleId": "h2_blue_right",
                "delta": -1
            },
            {
                "vehicleId": "h2_white_middle",
                "delta": -2
            },
            {
                "vehicleId": "h2_red_target",
                "delta": 3
            }
        ],
        "states": [
            "0,2|0,5|1,1|1,3|1,6|2,2|2,5|4,6|5,0|5,2|6,0|6,1|6,4|7,1",
            "0,2|0,3|1,1|1,3|1,6|2,2|2,5|4,6|5,0|5,2|6,0|6,1|6,4|7,1",
            "0,2|0,3|1,1|1,3|0,6|2,2|2,5|4,6|5,0|5,2|6,0|6,1|6,4|7,1",
            "0,2|0,3|1,1|1,3|0,6|2,2|0,5|4,6|5,0|5,2|6,0|6,1|6,4|7,1",
            "0,2|0,3|1,1|1,3|0,6|2,5|0,5|4,6|5,0|5,2|6,0|6,1|6,4|7,1"
        ]
    },
    "truck_escape_2_medium_3": {
        "moves": [
            {
                "vehicleId": "h3_purple_bus",
                "delta": 2
            },
            {
                "vehicleId": "h3_blue_top",
                "delta": -1
            },
            {
                "vehicleId": "h3_red_target",
                "delta": 5
            }
        ],
        "states": [
            "1,3|1,6|2,0|4,0|4,4|5,1|5,4|7,1",
            "3,3|1,6|2,0|4,0|4,4|5,1|5,4|7,1",
            "3,3|0,6|2,0|4,0|4,4|5,1|5,4|7,1",
            "3,3|0,6|2,5|4,0|4,4|5,1|5,4|7,1"
        ]
    },
    "truck_escape_2_medium_4": {
        "moves": [
            {
                "vehicleId": "h4_white_right",
                "delta": -1
            },
            {
                "vehicleId": "h4_sand_pickup",
                "delta": 2
            },
            {
                "vehicleId": "h4_white_middle",
                "delta": 2
            },
            {
                "vehicleId": "h4_red_target",
                "delta": 4
            }
        ],
        "states": [
            "0,0|0,2|0,3|1,3|1,6|2,0|2,1|3,1|4,2|3,6|5,2|6,0|6,3",
            "0,0|0,2|0,3|1,3|0,6|2,0|2,1|3,1|4,2|3,6|5,2|6,0|6,3",
            "0,0|0,2|0,3|1,3|0,6|2,0|2,1|3,1|4,4|3,6|5,2|6,0|6,3",
            "0,0|0,2|0,3|3,3|0,6|2,0|2,1|3,1|4,4|3,6|5,2|6,0|6,3",
            "0,0|0,2|0,3|3,3|0,6|2,0|2,5|3,1|4,4|3,6|5,2|6,0|6,3"
        ]
    },
    "truck_escape_2_medium_5": {
        "moves": [
            {
                "vehicleId": "h5_red_target",
                "delta": 1
            },
            {
                "vehicleId": "h5_white_left",
                "delta": 2
            },
            {
                "vehicleId": "h5_sand_semi",
                "delta": -1
            },
            {
                "vehicleId": "h5_purple_bottom",
                "delta": -2
            },
            {
                "vehicleId": "h5_white_pickup_right",
                "delta": -1
            },
            {
                "vehicleId": "h5_white_right_bottom",
                "delta": 3
            },
            {
                "vehicleId": "h5_white_pickup_right",
                "delta": 2
            },
            {
                "vehicleId": "h5_purple_top",
                "delta": 2
            },
            {
                "vehicleId": "h5_purple_bottom",
                "delta": 2
            },
            {
                "vehicleId": "h5_red_target",
                "delta": 4
            }
        ],
        "states": [
            "0,0|0,2|0,5|1,1|1,4|2,0|2,5|4,2|3,3|5,0|4,4|6,0",
            "0,0|0,2|0,5|1,1|1,4|2,1|2,5|4,2|3,3|5,0|4,4|6,0",
            "2,0|0,2|0,5|1,1|1,4|2,1|2,5|4,2|3,3|5,0|4,4|6,0",
            "2,0|0,2|0,5|1,0|1,4|2,1|2,5|4,2|3,3|5,0|4,4|6,0",
            "2,0|0,2|0,5|1,0|1,4|2,1|2,5|4,2|1,3|5,0|4,4|6,0",
            "2,0|0,2|0,5|1,0|1,4|2,1|2,5|4,2|1,3|5,0|4,3|6,0",
            "2,0|0,2|0,5|1,0|1,4|2,1|5,5|4,2|1,3|5,0|4,3|6,0",
            "2,0|0,2|0,5|1,0|1,4|2,1|5,5|4,2|1,3|5,0|4,5|6,0",
            "2,0|0,2|0,5|1,0|3,4|2,1|5,5|4,2|1,3|5,0|4,5|6,0",
            "2,0|0,2|0,5|1,0|3,4|2,1|5,5|4,2|3,3|5,0|4,5|6,0",
            "2,0|0,2|0,5|1,0|3,4|2,5|5,5|4,2|3,3|5,0|4,5|6,0"
        ]
    },
    "truck_escape_2_medium_6": {
        "moves": [
            {
                "vehicleId": "h6_purple_top",
                "delta": 2
            },
            {
                "vehicleId": "h6_white_top",
                "delta": -1
            },
            {
                "vehicleId": "h6_blue_middle",
                "delta": -1
            },
            {
                "vehicleId": "h6_white_right",
                "delta": 2
            },
            {
                "vehicleId": "h6_blue_right",
                "delta": 2
            },
            {
                "vehicleId": "h6_red_target",
                "delta": 5
            }
        ],
        "states": [
            "0,0|0,2|1,0|1,2|1,3|1,6|2,0|3,0|3,1|3,6|7,0|7,2",
            "0,0|0,4|1,0|1,2|1,3|1,6|2,0|3,0|3,1|3,6|7,0|7,2",
            "0,0|0,4|1,0|0,2|1,3|1,6|2,0|3,0|3,1|3,6|7,0|7,2",
            "0,0|0,4|1,0|0,2|0,3|1,6|2,0|3,0|3,1|3,6|7,0|7,2",
            "0,0|0,4|1,0|0,2|0,3|1,6|2,0|3,0|3,1|5,6|7,0|7,2",
            "0,0|0,4|1,0|0,2|0,3|3,6|2,0|3,0|3,1|5,6|7,0|7,2",
            "0,0|0,4|1,0|0,2|0,3|3,6|2,5|3,0|3,1|5,6|7,0|7,2"
        ]
    },
    "truck_escape_2_medium_7": {
        "moves": [
            {
                "vehicleId": "h7_white_top",
                "delta": -1
            },
            {
                "vehicleId": "h7_white_middle",
                "delta": -3
            },
            {
                "vehicleId": "h7_white_pickup",
                "delta": -2
            },
            {
                "vehicleId": "h7_purple_right",
                "delta": 2
            },
            {
                "vehicleId": "h7_red_target",
                "delta": 3
            }
        ],
        "states": [
            "0,0|0,1|1,5|1,6|2,2|3,0|3,2|3,4|4,5|6,4",
            "0,0|0,1|0,5|1,6|2,2|3,0|3,2|3,4|4,5|6,4",
            "0,0|0,1|0,5|1,6|2,2|3,0|3,2|0,4|4,5|6,4",
            "0,0|0,1|0,5|1,6|2,2|3,0|3,2|0,4|4,3|6,4",
            "0,0|0,1|0,5|3,6|2,2|3,0|3,2|0,4|4,3|6,4",
            "0,0|0,1|0,5|3,6|2,5|3,0|3,2|0,4|4,3|6,4"
        ]
    },
    "truck_escape_2_medium_8": {
        "moves": [
            {
                "vehicleId": "h8_white_top",
                "delta": -1
            },
            {
                "vehicleId": "h8_sand_bus",
                "delta": 2
            },
            {
                "vehicleId": "h8_red_target",
                "delta": 4
            }
        ],
        "states": [
            "1,4|1,6|2,1|3,0|3,2|3,4|5,0|7,5",
            "0,4|1,6|2,1|3,0|3,2|3,4|5,0|7,5",
            "0,4|3,6|2,1|3,0|3,2|3,4|5,0|7,5",
            "0,4|3,6|2,5|3,0|3,2|3,4|5,0|7,5"
        ]
    },
    "truck_escape_2_medium_9": {
        "moves": [
            {
                "vehicleId": "h9_white_coupe",
                "delta": -1
            },
            {
                "vehicleId": "h9_white_pickup_top",
                "delta": -3
            },
            {
                "vehicleId": "h9_blue_right",
                "delta": -2
            },
            {
                "vehicleId": "h9_cream_coupe",
                "delta": -1
            },
            {
                "vehicleId": "h9_sand_bus",
                "delta": 3
            },
            {
                "vehicleId": "h9_red_target",
                "delta": 4
            }
        ],
        "states": [
            "0,0|0,4|0,6|1,0|1,4|2,1|2,5|3,0|3,1|4,1|4,2|4,5|6,4|7,0",
            "0,0|0,3|0,6|1,0|1,4|2,1|2,5|3,0|3,1|4,1|4,2|4,5|6,4|7,0",
            "0,0|0,3|0,6|1,0|1,1|2,1|2,5|3,0|3,1|4,1|4,2|4,5|6,4|7,0",
            "0,0|0,3|0,6|1,0|1,1|2,1|0,5|3,0|3,1|4,1|4,2|4,5|6,4|7,0",
            "0,0|0,3|0,6|1,0|1,1|2,1|0,5|3,0|3,1|4,1|4,2|4,4|6,4|7,0",
            "0,0|0,3|3,6|1,0|1,1|2,1|0,5|3,0|3,1|4,1|4,2|4,4|6,4|7,0",
            "0,0|0,3|3,6|1,0|1,1|2,5|0,5|3,0|3,1|4,1|4,2|4,4|6,4|7,0"
        ]
    },
    "truck_escape_2_medium_10": {
        "moves": [
            {
                "vehicleId": "h10_blue_middle",
                "delta": 1
            },
            {
                "vehicleId": "h10_sand_bus",
                "delta": 1
            },
            {
                "vehicleId": "h10_red_target",
                "delta": 5
            }
        ],
        "states": [
            "0,0|0,1|0,3|2,0|2,2|2,6|3,0|3,4|5,1|5,5",
            "0,0|0,1|0,3|2,0|3,2|2,6|3,0|3,4|5,1|5,5",
            "0,0|0,1|0,3|2,0|3,2|3,6|3,0|3,4|5,1|5,5",
            "0,0|0,1|0,3|2,5|3,2|3,6|3,0|3,4|5,1|5,5"
        ]
    }
};

export const TRUCK_ESCAPE_2_REFERENCE_SOLUTIONS: Readonly<Record<string, TruckEscape2ReferenceSolution>> = (() => {
    const result: Record<string, TruckEscape2ReferenceSolution> = {};
    for (const id of Object.keys(ENCODED_REFERENCE_SOLUTIONS)) {
        const encoded = ENCODED_REFERENCE_SOLUTIONS[id];
        result[id] = {
            source: 'verified-optimal',
            solverVersion: 'truck2-bfs-v1',
            optimalMoves: encoded.moves.length,
            moves: encoded.moves,
            states: encoded.states,
        };
    }
    return result;
})();

export function getTruckEscape2ReferenceSolution(levelId: string): TruckEscape2ReferenceSolution | null {
    return TRUCK_ESCAPE_2_REFERENCE_SOLUTIONS[levelId] ?? null;
}
