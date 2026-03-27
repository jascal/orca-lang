package orca_runtime_go

import (
	"regexp"
	"strconv"
	"strings"
)

// ParseError represents a parsing error.
type ParseError struct {
	Message string
}

func (e ParseError) Error() string {
	return e.Message
}

// MdElement is a markdown element.
type MdElement interface{}

// MdHeading is a heading element.
type MdHeading struct {
	Level int
	Text  string
}

// MdTable is a table element.
type MdTable struct {
	Headers []string
	Rows    [][]string
}

// MdBulletList is a bullet list element.
type MdBulletList struct {
	Items []string
}

// MdBlockquote is a blockquote element.
type MdBlockquote struct {
	Text string
}

// MdSeparator is a machine separator.
type MdSeparator struct{}

// parseOrcaMd parses an Orca markdown source into a MachineDef.
func ParseOrcaMd(source string) (*MachineDef, error) {
	elements := parseMarkdownStructure(source)

	// Check for multi-machine (separators)
	hasSeparators := false
	for _, el := range elements {
		if _, ok := el.(MdSeparator); ok {
			hasSeparators = true
			break
		}
	}
	if hasSeparators {
		machines, err := parseOrcaMdMulti(source)
		if err != nil {
			return nil, err
		}
		return machines[0], nil
	}

	return parseMachineFromElements(elements)
}

// parseOrcaMdMulti parses multiple machines from a multi-machine file.
func parseOrcaMdMulti(source string) ([]*MachineDef, error) {
	elements := parseMarkdownStructure(source)

	// Split by separators
	var chunks [][]MdElement
	var current []MdElement
	for _, el := range elements {
		if _, ok := el.(MdSeparator); ok {
			if len(current) > 0 {
				chunks = append(chunks, current)
				current = nil
			}
		} else {
			current = append(current, el)
		}
	}
	if len(current) > 0 {
		chunks = append(chunks, current)
	}

	var result []*MachineDef
	for _, chunk := range chunks {
		machine, err := parseMachineFromElements(chunk)
		if err != nil {
			return nil, err
		}
		result = append(result, machine)
	}
	return result, nil
}

func parseMarkdownStructure(source string) []MdElement {
	lines := strings.Split(source, "\n")
	var elements []MdElement
	i := 0

	for i < len(lines) {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			i++
			continue
		}

		// Skip code blocks
		if strings.HasPrefix(trimmed, "```") {
			i++
			for i < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[i]), "```") {
				i++
			}
			if i < len(lines) {
				i++
			}
			continue
		}

		// Heading
		headingMatch := regexp.MustCompile(`^(#{1,6})\s+(.+)$`).FindStringSubmatch(trimmed)
		if headingMatch != nil {
			level := len(headingMatch[1])
			elements = append(elements, MdHeading{Level: level, Text: strings.TrimSpace(headingMatch[2])})
			i++
			continue
		}

		// Separator
		if regexp.MustCompile(`^---+$`).MatchString(trimmed) {
			elements = append(elements, MdSeparator{})
			i++
			continue
		}

		// Blockquote
		if strings.HasPrefix(trimmed, ">") {
			var lines2 []string
			for i < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[i]), ">") {
				q := strings.TrimSpace(lines[i])
				q = strings.TrimPrefix(q, ">")
				q = strings.TrimSpace(q)
				lines2 = append(lines2, q)
				i++
			}
			elements = append(elements, MdBlockquote{Text: strings.Join(lines2, "\n")})
			continue
		}

		// Table
		if strings.HasPrefix(trimmed, "|") {
			var tableLines []string
			for i < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[i]), "|") {
				tableLines = append(tableLines, strings.TrimSpace(lines[i]))
				i++
			}
			if len(tableLines) >= 2 {
				headers := splitTableRow(tableLines[0])
				dataStart := 1
				if regexp.MustCompile(`^\|[\s\-:|]+\|`).MatchString(tableLines[1]) {
					dataStart = 2
				}
				rows := make([][]string, 0, len(tableLines)-dataStart)
				for j := dataStart; j < len(tableLines); j++ {
					rows = append(rows, splitTableRow(tableLines[j]))
				}
				elements = append(elements, MdTable{Headers: headers, Rows: rows})
			}
			continue
		}

		// Bullet list
		if strings.HasPrefix(trimmed, "- ") {
			var items []string
			for i < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[i]), "- ") {
				item := strings.TrimSpace(lines[i])
				item = strings.TrimPrefix(item, "- ")
				items = append(items, item)
				i++
			}
			elements = append(elements, MdBulletList{Items: items})
			continue
		}

		i++
	}

	return elements
}

func splitTableRow(line string) []string {
	cells := strings.Split(line, "|")
	if len(cells) > 0 && strings.TrimSpace(cells[0]) == "" {
		cells = cells[1:]
	}
	if len(cells) > 0 && strings.TrimSpace(cells[len(cells)-1]) == "" {
		cells = cells[:len(cells)-1]
	}
	for i := range cells {
		cells[i] = strings.TrimSpace(cells[i])
	}
	return cells
}

func parseMachineFromElements(elements []MdElement) (*MachineDef, error) {
	machineName := "unknown"
	context := make(Context)
	var events []string
	var transitions []Transition
	guards := make(map[string]GuardExpression)
	var actions []ActionSignature
	var stateEntries []*mdStateEntry
	var currentEntry *mdStateEntry

	i := 0
	for i < len(elements) {
		el := elements[i]

		switch e := el.(type) {
		case MdHeading:
			// Machine heading
			if e.Level == 1 && strings.HasPrefix(e.Text, "machine ") {
				machineName = strings.TrimSpace(e.Text[8:])
				currentEntry = nil
				i++
				continue
			}

			// Section heading
			sectionName := strings.ToLower(e.Text)
			if sectionName == "context" || sectionName == "events" || sectionName == "transitions" ||
				sectionName == "guards" || sectionName == "actions" {
				currentEntry = nil
				if i+1 < len(elements) {
					nextEl := elements[i+1]

					if sectionName == "context" {
						if table, ok := nextEl.(MdTable); ok {
							fi := findColumnIndex(table.Headers, "field")
							di := findColumnIndex(table.Headers, "default")
							for _, row := range table.Rows {
								name := ""
								defaultStr := ""
								if fi >= 0 && fi < len(row) {
									name = strings.TrimSpace(row[fi])
								}
								if di >= 0 && di < len(row) {
									defaultStr = strings.TrimSpace(row[di])
								}
								context[name] = parseDefaultValue(defaultStr)
							}
							i += 2
							continue
						}
					} else if sectionName == "events" {
						if bl, ok := nextEl.(MdBulletList); ok {
							for _, item := range bl.Items {
								items := strings.Split(item, ",")
								for _, n := range items {
									n = strings.TrimSpace(n)
									if n != "" {
										events = append(events, n)
									}
								}
							}
							i += 2
							continue
						}
					} else if sectionName == "transitions" {
						if table, ok := nextEl.(MdTable); ok {
							si := findColumnIndex(table.Headers, "source")
							ei := findColumnIndex(table.Headers, "event")
							gi := findColumnIndex(table.Headers, "guard")
							ti := findColumnIndex(table.Headers, "target")
							ai := findColumnIndex(table.Headers, "action")
							for _, row := range table.Rows {
								src := ""
								evt := ""
								guard := ""
								target := ""
								action := ""
								if si >= 0 && si < len(row) {
									src = strings.TrimSpace(row[si])
								}
								if ei >= 0 && ei < len(row) {
									evt = strings.TrimSpace(row[ei])
								}
								if gi >= 0 && gi < len(row) {
									guard = strings.TrimSpace(row[gi])
								}
								if ti >= 0 && ti < len(row) {
									target = strings.TrimSpace(row[ti])
								}
								if ai >= 0 && ai < len(row) {
									action = strings.TrimSpace(row[ai])
								}
								if guard == "" || guard == "_" {
									guard = ""
								}
								if action == "" || action == "_" {
									action = ""
								}
								transitions = append(transitions, Transition{
									Source: src,
									Event:  evt,
									Guard:  guard,
									Target: target,
									Action: action,
								})
							}
							i += 2
							continue
						}
					} else if sectionName == "guards" {
						if table, ok := nextEl.(MdTable); ok {
							ni := findColumnIndex(table.Headers, "name")
							ei := findColumnIndex(table.Headers, "expression")
							for _, row := range table.Rows {
								name := ""
								exprStr := ""
								if ni >= 0 && ni < len(row) {
									name = strings.TrimSpace(row[ni])
								}
								if ei >= 0 && ei < len(row) {
									exprStr = strings.TrimSpace(row[ei])
									exprStr = strings.Trim(exprStr, "`")
								}
								guards[name] = parseGuardExpression(exprStr)
							}
							i += 2
							continue
						}
					} else if sectionName == "actions" {
						if table, ok := nextEl.(MdTable); ok {
							ni := findColumnIndex(table.Headers, "name")
							si := findColumnIndex(table.Headers, "signature")
							for _, row := range table.Rows {
								name := ""
								sig := ""
								if ni >= 0 && ni < len(row) {
									name = strings.TrimSpace(row[ni])
								}
								if si >= 0 && si < len(row) {
									sig = strings.TrimSpace(row[si])
									sig = strings.Trim(sig, "`")
								}
								actions = append(actions, parseActionSignature(name, sig))
							}
							i += 2
							continue
						}
					}
				}
				i++
				continue
			}

			// State heading
			stateMatch := regexp.MustCompile(`^state\s+(\w+)(.*)`).FindStringSubmatch(e.Text)
			if stateMatch != nil {
				annot := parseAnnotations(stateMatch[2])
				currentEntry = &mdStateEntry{
					entryType:   "state",
					level:       e.Level,
					name:        stateMatch[1],
					isInitial:   annot["is_initial"] == "true",
					isFinal:     annot["is_final"] == "true",
					isParallel:  annot["is_parallel"] == "true",
					syncStrategy: annot["sync_strategy"],
				}
				stateEntries = append(stateEntries, currentEntry)
				i++
				continue
			}

			// Region heading
			regionMatch := regexp.MustCompile(`^region\s+(\w+)$`).FindStringSubmatch(e.Text)
			if regionMatch != nil {
				currentEntry = nil
				stateEntries = append(stateEntries, &mdStateEntry{
					entryType: "region",
					level:     e.Level,
					name:      regionMatch[1],
				})
				i++
				continue
			}

			currentEntry = nil
			i++
			continue

		case MdBlockquote:
			if currentEntry != nil {
				currentEntry.description = e.Text
			}
			i++
			continue

		case MdBulletList:
			if currentEntry != nil {
				for _, item := range e.Items {
					parseStateBullet(currentEntry, item)
				}
			}
			i++
			continue
		}

		i++
	}

	// Build state hierarchy
	states := buildStatesFromEntries(stateEntries, 0, "")

	return &MachineDef{
		Name:        machineName,
		Context:     context,
		Events:      events,
		States:      states,
		Transitions: transitions,
		Guards:      guards,
		Actions:     actions,
	}, nil
}

type mdStateEntry struct {
	entryType         string
	level              int
	name               string
	isInitial          bool
	isFinal            bool
	isParallel         bool
	syncStrategy       string
	description        string
	onEntry            string
	onExit             string
	onDone             string
	timeout            *TimeoutDef
	ignoredEvents      []string
	invoke             *InvokeDef
	pendingOnError     string
}

func findColumnIndex(headers []string, name string) int {
	for i, h := range headers {
		if strings.ToLower(strings.TrimSpace(h)) == name {
			return i
		}
	}
	return -1
}

func parseDefaultValue(s string) any {
	if s == "" {
		return nil
	}
	if s == "true" || s == "false" {
		return s == "true"
	}
	if regexp.MustCompile(`^\d+$`).MatchString(s) {
		n, _ := strconv.Atoi(s)
		return n
	}
	if regexp.MustCompile(`^\d+\.\d+$`).MatchString(s) {
		n, _ := strconv.ParseFloat(s, 64)
		return n
	}
	if (strings.HasPrefix(s, `"`) && strings.HasSuffix(s, `"`)) ||
		(strings.HasPrefix(s, "'")) && strings.HasSuffix(s, "'") {
		return s[1 : len(s)-1]
	}
	return s
}

func parseAnnotations(text string) map[string]string {
	result := map[string]string{
		"is_initial":  "false",
		"is_final":    "false",
		"is_parallel": "false",
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return result
	}

	bracketMatch := regexp.MustCompile(`\[(.+)\]`).FindStringSubmatch(text)
	if bracketMatch == nil {
		return result
	}
	parts := strings.Split(bracketMatch[1], ",")
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "initial" {
			result["is_initial"] = "true"
		} else if part == "final" {
			result["is_final"] = "true"
		} else if part == "parallel" {
			result["is_parallel"] = "true"
		} else if strings.HasPrefix(part, "sync:") {
			v := strings.TrimPrefix(part, "sync:")
			v = strings.ReplaceAll(v, "_", "-")
			result["sync_strategy"] = v
		}
	}
	return result
}

func parseStateBullet(entry *mdStateEntry, text string) {
	text = strings.TrimSpace(text)

	if strings.HasPrefix(text, "on_entry:") {
		val := strings.TrimSpace(text[8:])
		if strings.HasPrefix(val, "->") {
			val = strings.TrimSpace(val[2:])
		}
		entry.onEntry = val
	} else if strings.HasPrefix(text, "on_exit:") {
		val := strings.TrimSpace(text[8:])
		if strings.HasPrefix(val, "->") {
			val = strings.TrimSpace(val[2:])
		}
		entry.onExit = val
	} else if strings.HasPrefix(text, "on_done:") {
		val := strings.TrimSpace(text[8:])
		if strings.HasPrefix(val, "->") {
			val = strings.TrimSpace(val[2:])
		}
		entry.onDone = val
		if entry.invoke != nil {
			entry.invoke.OnDone = val
		}
	} else if strings.HasPrefix(text, "on_error:") {
		val := strings.TrimSpace(text[9:])
		if strings.HasPrefix(val, "->") {
			val = strings.TrimSpace(val[2:])
		}
		entry.pendingOnError = val
		if entry.invoke != nil {
			entry.invoke.OnError = val
		}
	} else if strings.HasPrefix(text, "timeout:") {
		rest := strings.TrimSpace(text[8:])
		arrowIdx := strings.Index(rest, "->")
		if arrowIdx != -1 {
			entry.timeout = &TimeoutDef{
				Duration: strings.TrimSpace(rest[:arrowIdx]),
				Target:   strings.TrimSpace(rest[arrowIdx+2:]),
			}
		}
	} else if strings.HasPrefix(text, "ignore:") {
		names := strings.Split(strings.TrimSpace(text[7:]), ",")
		for _, n := range names {
			n = strings.TrimSpace(n)
			if n != "" {
				entry.ignoredEvents = append(entry.ignoredEvents, n)
			}
		}
	} else if strings.HasPrefix(text, "invoke:") {
		rest := strings.TrimSpace(text[7:])
		machineName := rest
		inputMap := map[string]string{}

		// Check for input mapping
		inputMatch := regexp.MustCompile(`input:\s*\{([^}]+)\}`).FindStringSubmatchIndex(rest)
		if inputMatch != nil {
			// inputMatch[0], inputMatch[1] are start/end of full match
			machineName = strings.TrimSpace(rest[:inputMatch[0]])
			inputStr := rest[inputMatch[2]:inputMatch[3]] // [1] is start of first capture group
			for _, pair := range strings.Split(inputStr, ",") {
				if idx := strings.Index(pair, ":"); idx != -1 {
					key := strings.TrimSpace(pair[:idx])
					value := strings.TrimSpace(pair[idx+1:])
					inputMap[key] = value
				}
			}
		}

		entry.invoke = &InvokeDef{
			Machine: machineName,
			Input:   inputMap,
		}
		if entry.pendingOnError != "" {
			entry.invoke.OnError = entry.pendingOnError
		}
	}
}

func parseGuardExpression(s string) GuardExpression {
	s = strings.TrimSpace(s)
	if s == "" {
		return GuardTrue{}
	}

	// Simple cases
	if s == "true" {
		return GuardTrue{}
	}
	if s == "false" {
		return GuardFalse{}
	}

	// Comparison: ctx.field op value
	compareMatch := regexp.MustCompile(`^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$`).FindStringSubmatch(s)
	if compareMatch != nil {
		left := VariableRef{Path: parseVarPath(compareMatch[1])}
		op := compareMatch[2]
		right := parseValueRef(compareMatch[3])
		switch op {
		case "==":
			op = "eq"
		case "!=":
			op = "ne"
		case ">=":
			op = "ge"
		case "<=":
			op = "le"
		case ">":
			op = "gt"
		case "<":
			op = "lt"
		}
		return GuardCompare{Op: op, Left: left, Right: right}
	}

	// Nullcheck: ctx.field != null
	nullMatch := regexp.MustCompile(`^(.+?)\s*(==|!=)\s*null$`).FindStringSubmatch(s)
	if nullMatch != nil {
		return GuardNullcheck{
			Expr:   VariableRef{Path: parseVarPath(nullMatch[1])},
			IsNull: nullMatch[2] == "==",
		}
	}

	return GuardTrue{}
}

func parseVarPath(s string) []string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "ctx.")
	s = strings.TrimPrefix(s, "context.")
	parts := strings.Split(s, ".")
	var result []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" && p != "ctx" && p != "context" {
			result = append(result, p)
		}
	}
	return result
}

func parseValueRef(s string) ValueRef {
	s = strings.TrimSpace(s)
	if s == "true" || s == "false" {
		return ValueRef{Type: "boolean", Value: s == "true"}
	}
	if regexp.MustCompile(`^-?\d+(\.\d+)?$`).MatchString(s) {
		if strings.Contains(s, ".") {
			v, _ := strconv.ParseFloat(s, 64)
			return ValueRef{Type: "number", Value: v}
		}
		v, _ := strconv.Atoi(s)
		return ValueRef{Type: "number", Value: v}
	}
	if s == "null" {
		return ValueRef{Type: "null", Value: nil}
	}
	if (strings.HasPrefix(s, `"`) && strings.HasSuffix(s, `"`)) ||
		(strings.HasPrefix(s, "'") && strings.HasSuffix(s, "'")) {
		return ValueRef{Type: "string", Value: s[1 : len(s)-1]}
	}
	return ValueRef{Type: "string", Value: s}
}

func parseActionSignature(name, sig string) ActionSignature {
	sig = strings.TrimSpace(sig)
	sig = strings.Trim(sig, "()")

	hasEffect := false
	effectType := ""
	if strings.Contains(sig, "->") {
		hasEffect = true
		parts := strings.Split(sig, "->")
		sig = strings.TrimSpace(parts[0])
		if len(parts) > 1 {
			effectType = strings.TrimSpace(parts[1])
		}
	}

	params := strings.Split(sig, ",")
	var paramList []string
	for _, p := range params {
		p = strings.TrimSpace(p)
		if p != "" {
			paramList = append(paramList, p)
		}
	}

	returnType := "void"
	if hasEffect && effectType != "" {
		returnType = effectType
	}

	return ActionSignature{
		Name:       name,
		Parameters: paramList,
		ReturnType: returnType,
		HasEffect:  hasEffect,
		EffectType: effectType,
	}
}

func buildStatesFromEntries(entries []*mdStateEntry, startIdx int, parentName string) []StateDef {
	var states []StateDef
	i := startIdx

	for i < len(entries) {
		entry := entries[i]
		if entry.entryType == "region" {
			break
		}
		if entry.level < entries[startIdx].level {
			break
		}
		if entry.level > entries[startIdx].level {
			i++
			continue
		}

		state := StateDef{
			Name:        entry.name,
			IsInitial:   entry.isInitial,
			IsFinal:     entry.isFinal,
			Description: entry.description,
			OnEntry:     entry.onEntry,
			OnExit:      entry.onExit,
			OnDone:      entry.onDone,
			Parent:      parentName,
			Timeout:     entry.timeout,
		}
		if len(entry.ignoredEvents) > 0 {
			state.IgnoredEvents = entry.ignoredEvents
		}
		if entry.invoke != nil {
			state.Invoke = entry.invoke
		}

		i++

		if entry.isParallel {
			parallelDef, newIdx := buildParallelRegions(entries, i, entry.level+1, entry.name, entry.syncStrategy)
			state.Parallel = parallelDef
			i = newIdx
		} else if i < len(entries) && entries[i].level == entry.level+1 && entries[i].entryType == "state" {
			childStates := buildStatesFromEntries(entries, i, entry.name)
			state.Contains = childStates
			// Find the next index after children
			targetLevel := entry.level
			for i < len(entries) && entries[i].level > targetLevel {
				if entries[i].level == targetLevel+1 && entries[i].entryType == "state" {
					// This is a child, skip to after all children
					childLevel := entries[i].level
					for i < len(entries) && entries[i].level >= childLevel {
						i++
					}
					break
				}
				i++
			}
			if i >= len(entries) {
				break
			}
			// Skip region entries at same level
			for i < len(entries) && entries[i].level == entry.level && entries[i].entryType == "region" {
				i++
			}
		}

		states = append(states, state)
	}

	return states
}

func buildParallelRegions(entries []*mdStateEntry, startIdx int, regionLevel int, parentName string, syncStrategy string) (*ParallelDef, int) {
	regions := []RegionDef{}
	i := startIdx

	for i < len(entries) && entries[i].level >= regionLevel {
		if entries[i].entryType != "region" || entries[i].level != regionLevel {
			break
		}

		region := RegionDef{Name: entries[i].name}
		i++

		var regionStates []StateDef
		for i < len(entries) && entries[i].level > regionLevel {
			if entries[i].entryType == "state" && entries[i].level == regionLevel+1 {
				entry := entries[i]
				state := StateDef{
					Name:        entry.name,
					IsInitial:   entry.isInitial,
					IsFinal:     entry.isFinal,
					Description: entry.description,
					OnEntry:     entry.onEntry,
					OnExit:      entry.onExit,
					OnDone:      entry.onDone,
					Parent:      parentName,
					Timeout:     entry.timeout,
				}
				if len(entry.ignoredEvents) > 0 {
					state.IgnoredEvents = entry.ignoredEvents
				}
				if entry.invoke != nil {
					state.Invoke = entry.invoke
				}
				regionStates = append(regionStates, state)
			}
			i++
		}
		region.States = regionStates
		regions = append(regions, region)
	}

	sync := syncStrategy
	if sync == "" {
		sync = "all-final"
	}

	return &ParallelDef{Regions: regions, Sync: sync}, i
}

// ParseOrcaAuto auto-detects and parses Orca source.
func ParseOrcaAuto(source string, filename string) (*MachineDef, error) {
	if strings.HasSuffix(filename, ".orca.md") || strings.HasSuffix(filename, ".md") {
		return ParseOrcaMd(source)
	}
	// Content sniffing
	if regexp.MustCompile(`^\s*#\s+machine\s+`).MatchString(source) {
		return ParseOrcaMd(source)
	}
	return nil, ParseError{Message: "Unknown file format"}
}
