package poison

import (
	"encoding/json"
	"strconv"
	"strings"
)

type responseText struct {
	lane  string
	text  string
	final bool
}

// Decode text-bearing protocol fields into independent output lanes. Choices,
// content blocks, reasoning, and tool arguments must never create a keyword
// by concatenating unrelated strings. SSE deltas for one lane remain continuous.
func decodedResponseParts(data []byte) ([]responseText, error) {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	var out []responseText
	collectResponseParts(value, "response", &out)
	return out, nil
}

func responseIndex(v any, fallback int) string {
	if n, ok := v.(float64); ok {
		return strconv.FormatFloat(n, 'f', -1, 64)
	}
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return strconv.Itoa(fallback)
}

func appendResponsePart(out *[]responseText, lane string, v any) {
	if text, ok := v.(string); ok && text != "" {
		*out = append(*out, responseText{lane: lane, text: text})
	}
}

func collectResponseParts(value any, lane string, out *[]responseText) {
	switch v := value.(type) {
	case string:
		appendResponsePart(out, lane+"/text", v)
	case []any:
		for i, child := range v {
			collectResponseParts(child, lane+"/"+strconv.Itoa(i), out)
		}
	case map[string]any:
		if choices, ok := v["choices"].([]any); ok {
			for i, item := range choices {
				choice, ok := item.(map[string]any)
				if !ok {
					continue
				}
				choiceLane := lane + "/choice/" + responseIndex(choice["index"], i)
				if message, ok := choice["delta"]; ok {
					collectResponseParts(message, choiceLane, out)
				} else if message, ok := choice["message"]; ok {
					collectResponseParts(message, choiceLane, out)
				} else {
					appendResponsePart(out, choiceLane+"/text", choice["text"])
				}
				if reason, ok := choice["finish_reason"].(string); ok && reason != "" {
					*out = append(*out, responseText{lane: choiceLane, final: true})
				}
			}
			return
		}
		if candidates, ok := v["candidates"].([]any); ok {
			for i, item := range candidates {
				candidate, ok := item.(map[string]any)
				if !ok {
					continue
				}
				collectResponseParts(candidate["content"], lane+"/candidate/"+responseIndex(candidate["index"], i), out)
			}
			return
		}
		typ, _ := v["type"].(string)
		if typ == "message_stop" || typ == "response.completed" || typ == "response.done" {
			*out = append(*out, responseText{lane: lane, final: true})
			return
		}
		if typ == "content_block_stop" {
			*out = append(*out, responseText{lane: lane + "/block/" + responseIndex(v["index"], 0), final: true})
			return
		}
		if strings.HasPrefix(typ, "response.") {
			outputLane := lane + "/output/" + responseIndex(v["output_index"], 0)
			partLane := outputLane + "/part/" + responseIndex(v["content_index"], 0)
			kind := "text"
			if strings.Contains(typ, "reasoning") {
				kind = "reasoning"
			}
			if strings.Contains(typ, "summary") {
				partLane = outputLane + "/summary/" + responseIndex(v["summary_index"], 0)
			}
			if strings.Contains(typ, "function_call") {
				kind = "arguments"
			}
			if strings.Contains(typ, "refusal") {
				kind = "refusal"
			}
			if strings.HasSuffix(typ, ".delta") {
				appendResponsePart(out, partLane+"/"+kind, v["delta"])
				return
			}
			if strings.HasSuffix(typ, ".done") {
				endLane := partLane + "/" + kind
				switch typ {
				case "response.output_item.done":
					endLane = outputLane
				case "response.content_part.done", "response.reasoning_summary_part.done":
					endLane = partLane
				}
				*out = append(*out, responseText{lane: endLane, final: true})
				return
			}
		}
		if strings.HasPrefix(typ, "content_block_") {
			blockLane := lane + "/block/" + responseIndex(v["index"], 0)
			if block, ok := v["content_block"]; ok {
				collectResponseParts(block, blockLane, out)
			}
			if delta, ok := v["delta"]; ok {
				collectResponseParts(delta, blockLane, out)
			}
			return
		}
		for _, key := range []string{"text", "output_text", "completion", "thinking", "reasoning", "reasoning_content", "partial_json", "arguments", "refusal", "error_description"} {
			appendResponsePart(out, lane+"/"+key, v[key])
		}
		if content, ok := v["content"]; ok {
			switch items := content.(type) {
			case string:
				appendResponsePart(out, lane+"/text", items)
			case []any:
				for i, item := range items {
					collectResponseParts(item, lane+"/block/"+strconv.Itoa(i), out)
				}
			default:
				collectResponseParts(items, lane, out)
			}
		}
		if parts, ok := v["parts"].([]any); ok {
			for i, item := range parts {
				collectResponseParts(item, lane+"/part/"+strconv.Itoa(i), out)
			}
		}
		if delta, ok := v["delta"]; ok {
			collectResponseParts(delta, lane, out)
		}
		if message, ok := v["message"]; ok {
			collectResponseParts(message, lane, out)
		}
		if err, ok := v["error"]; ok {
			collectResponseParts(err, lane+"/error", out)
		}
		if outputs, ok := v["output"].([]any); ok {
			for i, item := range outputs {
				collectResponseParts(item, lane+"/output/"+strconv.Itoa(i), out)
			}
		}
		if response, ok := v["response"]; ok {
			collectResponseParts(response, lane, out)
		}
		if tools, ok := v["tool_calls"].([]any); ok {
			for i, item := range tools {
				tool, ok := item.(map[string]any)
				if !ok {
					continue
				}
				collectResponseParts(tool["function"], lane+"/tool/"+responseIndex(tool["index"], i), out)
			}
		}
		if function, ok := v["function_call"]; ok {
			collectResponseParts(function, lane+"/tool/0", out)
		}
	}
}
