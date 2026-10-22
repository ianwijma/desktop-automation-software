# Structured inspectors and flow interfaces

Select a node to edit its configuration. Simple controls and **Advanced configuration** edit the same saved data; opening an inspector does not rewrite imported configuration. Workflow format remains version 2.

## Waits, conditions, and variables

**Wait for → Duration** pauses for a number of milliseconds. **Wait for → Detector match** exposes the selected detector, target, timeout, and polling interval. Choose a detector method to reveal its relevant fields. A detector wait continues after a match; timeout and detector errors still follow the existing runtime error behavior.

For a numeric condition, choose Number for each literal operand or select a numeric reference with **Use value from…**. The `gt`, `gte`, `lt`, and `lte` operators compare numbers. `truthy` uses only the first operand. Set variable uses the same typed value controls, including objects, arrays, booleans, and null.

Explicit mode changes remove settings that would conflict with the new choice. Duration waits remove detector settings; detector waits remove duration settings. A count loop removes its items value, and a foreach loop removes its count. Choosing `truthy` removes the second operand. Unrelated advanced fields remain intact. Undo restores the previous configuration.

## Flow inputs, outputs, and children

Click the canvas background to open **Flow overview**. Add properties to **Flow inputs** for default values. These are literal data: a string such as `${nodes.example}` remains a string and is not evaluated as an expression. Defaults retain their JSON types and can be overridden when the flow runs.

Add **Flow outputs** properties to map values returned at completion. Their reference picker includes outputs available at a Finish node and warns when a source may not run on every path. Both input and output records retain **Edit as JSON** for advanced editing.

Run child flow, Loop, and each group child show the selected child's declared input defaults. **Override** copies a default into that invocation's mapping; **Use default** removes that override. Custom mapping properties and whole-object references remain supported. Invoking the same child twice keeps the two input mappings independent. Child defaults are hints, not a new required-input schema.

Choose **Loop mode → For each item** to supply an array. Child input mappings can use `${item}`, `${index}`, or nested item paths. The loop supplies item/index to the child automatically; map them to other names as needed. **Repeat a count** exposes the iteration count instead. Both modes retain the safety limit.

## AI output schemas

Choose **Mode → structured** in Ask AI to build an output schema. Add named object properties, choose their types, mark required fields, describe them, and edit arrays and primitive enum choices. Nested object and array controls use the same pattern. The reference picker can discover explicitly declared object properties on the AI result; optional fields carry availability warnings.

Vision mode can also carry a schema for structured image responses. Selecting Text explicitly removes the schema so the runtime produces text. The connection still needs to support the requested operation; the builder does not establish provider or model conformance.

Use the schema's JSON editor for advanced keywords. Simple field edits preserve unrelated keywords and extensions. Schemas outside the builder's supported shape, including unions, references, and boolean schemas, remain available as JSON. Changing a schema type is an explicit replacement of incompatible type constraints; use Undo to restore the prior value. Large or deeply nested schemas use the JSON fallback.

If imported dependencies or local property references could be broken by renaming or removing a property, the builder asks you to make the coordinated change in JSON. It preserves the existing schema until that edit is applied.

## Compatibility

Saving and exporting preserve the authored types, reference strings, flow interfaces, child mappings, and unsupported schema features. No new provider requests, native permissions, execution mode, or database migration is introduced. Validation at execution remains authoritative: inferred schema types and default-value types cannot guarantee the shape of every runtime value.
