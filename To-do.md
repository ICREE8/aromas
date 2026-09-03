Part 1: Supabase Database Migration (Execute in SQL Editor)

Run the following SQL snippet in the Supabase SQL Editor (>_) to ensure database schema compatibility with the new quantity tracking, nullable pricing, and "Needs Price" operational status:

-- 1. Add quantity column if it does not already exist
alter table public.inventory 
add column if not exists qty integer default 1 check (qty >= 0);

-- 2. Allow listed_price and retail_msrp to be nullable for unpriced shipments
alter table public.inventory 
alter column listed_price drop not null,
alter column retail_msrp drop not null;

-- 3. Update existing 0-value items without pricing to null (optional cleanup)
-- update public.inventory set listed_price = null where listed_price = 0;

-- 4. Verify RLS policies remain intact
alter table public.inventory enable row level security;

Part 2: Detailed Architectural SpecificationsTask 1: Pricing Pipeline & "Needs Price" WorkflowWholesale shipments arrive unpriced. Pricing is set only after physical unboxing and inspection.Status Options:Valid statuses: "In Stock", "Sold", and "Needs Price".Update the status filter dropdown (#filter-status):All StatusIn StockNeeds Price (styled with amber indicator)SoldTable Badge & Interactive Cycling:Items with status "Needs Price" must display an amber badge:HTML     <button onclick="cycleStatus('${it.id}')" class="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30">
       ⚠️ Needs Price
     </button>
     
Clicking status cycles: "Needs Price" $\rightarrow$ "In Stock" $\rightarrow$ "Sold" $\rightarrow$ "Needs Price".When listedPrice is null, 0, or empty:Render "—" or <span class="text-amber-400 font-semibold">[Needs Price]</span>.Do not show $0.00.KPI & Quick Filter Pill:Add a high-visibility badge directly above the search bar or in the KPI card area:HTML     <div id="badge-needs-price-count" onclick="filterByNeedsPrice()" class="cursor-pointer px-3 py-1 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-bold flex items-center gap-1.5 hover:bg-amber-500/25 transition-all">
       <span>⚠️</span>
       <span id="count-needs-price">0 Need Pricing</span>
     </div>
     
Task 2: Multiples & Quantity (qty) TrackingKPI Calculation:Total Units In-Stock must compute:$$\text{Total Units} = \sum_{\text{status} \in \{\text{"In Stock"}, \text{"Needs Price"}\}} \text{item.qty}$$Listed Revenue must compute:$$\text{Revenue} = \sum_{\text{status} = \text{"In Stock"}} (\text{item.listedPrice} \times \text{item.qty})$$Table Quantity Steppers:Add a dedicated Qty column with inline stepper buttons:HTML     <div class="flex items-center gap-1.5 font-mono">
       <button onclick="adjustQty('${it.id}', -1)" class="w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold flex items-center justify-center transition-colors">-</button>
       <span class="w-6 text-center font-bold text-white">${it.qty || 1}</span>
       <button onclick="adjustQty('${it.id}', 1)" class="w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold flex items-center justify-center transition-colors">+</button>
     </div>
     
If qty drops to 0, trigger a confirmation or automatically toggle status to "Sold".If qty increases from 0, automatically revert status to "In Stock" (or "Needs Price" if price is empty).Modal Form Update:In both Add Bottle and Edit Bottle modals, include:HTML     <div>
       <label class="block text-slate-400 font-semibold mb-1">Quantity (Units)</label>
       <input id="bottle-qty" type="number" min="1" value="1" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white font-mono">
     </div>
     
Task 3: Vision Scanner Overhaul (Zero Guessing & Exhaustive Grid OCR)Delete All Hardcoded Mock Data:Audit the entire codebase for fallback arrays containing mock entries like Sauvage (38U600) or Bleu de Chanel (22Y01).In any catch block or empty result branch, throw or display the true error message via toast. Never silently inject fake items.Zero Price Guessing:Strip all price requirements from the vision prompt.The model must output null or omitted values for listedPrice and retailMSRP.Every detected photo item must be assigned status = "Needs Price" by default.Exhaustive Segmentation System Prompt:Use the following prompt structure for gemini-2.5-flash or gemini-3-flash-preview:JavaScript   const systemPrompt = `You are a forensic luxury fragrance inventory specialist and OCR cataloguer.
   Your job is to inspect dense photographs of perfume boxes, bottles, and wholesale deliveries.
   
   CRITICAL SEGMENTATION RULES:
   1. Systematically scan row-by-row, from top-left to bottom-right across the ENTIRE frame.
   2. Identify EVERY distinct bottle or box visible, even if partially occluded or in the background.
   3. Actively search for and extract the stamped/embossed BATCH CODE or etching (e.g., "38U600", "9140AM", "2109") on each unit. If occluded, set batchCode to null.
   4. If multiple identical bottles of the same fragrance and size are sitting together, increment the "qty" field rather than repeating rows.
   5. DO NOT estimate, predict, or guess retail prices or MSRP. Leave price fields completely out or null.
   6. Accurately identify concentration: EDP, EDT, Parfum, Extrait, or Cologne.
   
   Output a valid JSON array strictly adhering to the schema.`;
   
Structured Schema:JavaScript   responseSchema: {
     type: "ARRAY",
     items: {
       type: "OBJECT",
       properties: {
         batchCode: { type: "STRING" },
         name: { type: "STRING" },
         brand: { type: "STRING" },
         concentration: { type: "STRING" },
         size: { type: "STRING" },
         condition: { type: "STRING" },
         qty: { type: "INTEGER" }
       },
       required: ["name", "brand", "concentration", "size", "qty"]
     }
   }
   
Client-Side Canvas Downsampling:Keep maximum dimensions at 2400x2400 with 0.88 JPEG quality.This keeps payload size around ~600KB while preserving fine text contrast on embossed batch codes.Task 4: Staged Review Drawer RefactoringReview Table Columns:Render the staged results table with columns:[Batch / Code] (editable text)[Fragrance Name] (editable text)[House / Brand] (editable text)[Type] (select: EDP, EDT, Parfum, Extrait)[Size] (editable text)[Qty] (editable number)[Condition] (editable text)[Actions] (delete button ✕)Remove all price inputs from this staging view.Batch Commit Logic:JavaScript   const rowsToInsert = stagedDetectedBottles.map((b, idx) => ({
     id: `ARM-${Date.now()}-${idx}`,
     sku: b.batchCode || `ARM-${Date.now().toString().slice(-5)}`,
     name: b.name.trim(),
     brand: b.brand.trim(),
     concentration: b.concentration || "EDP",
     size: b.size || "3.4oz 100ml",
     condition: b.condition || "New Sealed",
     qty: Number(b.qty) || 1,
     listed_price: null,
     retail_msrp: null,
     status: "Needs Price",
     warehouse: "Shipment Inbound",
     updated_at: new Date().toISOString()
   }));
   
Task 5: Autonomous Sale Notification / Receipt ParserAdd a secondary modal tab or drag-zone: "📲 Drop Sale Screenshot / Receipt".User Flow:Operator drops an image of a sales confirmation (WhatsApp order confirmation, Zelle notification, invoice snippet, or Square text).Gemini parses:Target fragrance name / brandQuantity soldSale price (optional audit reference)Matching & Depletion Algorithm:JavaScript   async function processSoldNotification(parsedSale) {
     // 1. Find matching item in existing in-stock inventory
     const match = items.find(i => 
       i.status !== "Sold" && 
       (i.name.toLowerCase().includes(parsedSale.name.toLowerCase()) || 
        parsedSale.name.toLowerCase().includes(i.name.toLowerCase()))
     );

     if (!match) {
       showToast(`⚠️ Could not find active inventory for "${parsedSale.name}".`);
       return;
     }

     const soldQty = parsedSale.qty || 1;
     const newQty = Math.max(0, (match.qty || 1) - soldQty);
     const newStatus = newQty === 0 ? "Sold" : match.status;

     // 2. Persist update to Supabase
     if (window.sbClient && currentUser?.email !== "guest@aromas.local") {
       await window.sbClient
         .from("inventory")
         .update({ qty: newQty, status: newStatus, updated_at: new Date().toISOString() })
         .eq("id", match.id);
     }

     match.qty = newQty;
     match.status = newStatus;
     renderDashboard();
     showToast(`✅ Deducted ${soldQty}x "${match.name}". Remaining stock: ${newQty}`);
   }
   


---

## Part 3: Verification & Acceptance Checklist

1. [ ] **SQL Applied**: Verify `qty` column exists and `listed_price` allows `NULL` in Supabase.
2. [ ] **Toolbar & Header**: Action toolbar remains positioned cleanly above `#search-input`.
3. [ ] **Needs Price Badge**: Verify amber badge renders when `status === "Needs Price"` and price renders as `"—"`.
4. [ ] **Inline Quantity Steppers**: Clicking `+` and `-` updates `qty` and refreshes total unit KPI without page reloads.
5. [ ] **Zero Mock Fallbacks**: Disconnect network or provide invalid image $\rightarrow$ verify UI surfaces clear error toast without populating *Sauvage* or *Bleu de Chanel*.
6. [ ] **13-Bottle Photo Test**: Upload the supplier picture $\rightarrow$ verify model segments all visible boxes into the staged table with prices left blank.
7. [ ] **Commit & Deploy**: Push to `origin/main` $\rightarrow$ Netlify builds and publishes automatically.
```eof

This file is structured for direct consumption by an Antigravity agent or developer. It provides the SQL migration, frontend logic changes, revised vision schema, and the automated stock-depletion assistant.
