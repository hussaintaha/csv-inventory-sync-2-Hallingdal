import csvParser from "csv-parser";
import path from "path";
import fs from "fs";
import { graphqlRequest } from "../component/graphqlRequest";
import ftp from "basic-ftp";
import { finished } from "stream/promises";
import { Readable, Writable } from "stream";
import prisma from "../db.server";

const {
    FTP_HOST,
    FTP_PORT,
    FTP_USER,
    FTP_PASSWORD,
} = process.env;

// parseCSV from local
// async function parseCsv(filePath) {
//     const results = [];

//     // const file = fs.readFileSync(filePath, "utf8");
//     // const lines = file.split(/\r\n|\n/);
//     // console.log("Total lines in file:", lines.length);
//     // live store products sku: AV1645501,MI567465
//     const parser = fs
//         .createReadStream(filePath)
//         .pipe(csvParser({
//             separator: ";",
//             headers: false,
//             quote: "",        // disabling quotes
//             skipComments: false,
//             strict: false
//         }));

//     parser.on("data", row => results.push(row));
//     await finished(parser);
//     console.log("Parsed records:", results.length);
//     return results.map(r => ({ sku: r[2], qty: r[3] }));
// }

const LOCAL_CSV_PATH = path.join(process.cwd(), "public", "CSV", "ic_ean_CSV.csv");

async function downloadCsvFromFtp() {
    const client = new ftp.Client();
    const dir = path.dirname(LOCAL_CSV_PATH);

    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        await client.access({
            host: FTP_HOST,
            port: FTP_PORT,
            user: FTP_USER,
            password: FTP_PASSWORD,
            secure: false,
        });

        await client.downloadTo(LOCAL_CSV_PATH, "/ic_ean_CSV.csv");
        console.log("From downloadCsvFromFtp, downloaded CSV to:", LOCAL_CSV_PATH);
    } catch (error) {
        console.error("FTP download error from downloadCsvFromFtp:", error);
        throw error;
    } finally {
        client.close();
    }
}

async function processRow(row, shopData, counter) {
    const sku = row["PRODUCT_CODE"];
    const qty = parseInt(row["TOTAL"], 10) || 0;
    counter.count++;
    const IS_LOG = counter.count % 1000 === 0
    const IS_LOG_2 = counter.count % 500 === 0

    if (!sku || isNaN(qty)) return;

    try {
        const productSKUQuery = `
                query ProductVariantsList {
                    productVariants(first: 10, query: "sku:${sku}") {
                        nodes {
                            id
                            title
                            inventoryQuantity
                            inventoryItem {
                                id
                                inventoryLevels(first: 10) {
                                    edges {
                                        node {
                                            id
                                            location {
                                                id
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        pageInfo {
                            startCursor
                            endCursor
                        }
                    }
                }
            `;

        const dataOfProductSKU = await graphqlRequest(shopData, productSKUQuery);
        // console.log("data=================>", data);
        // console.log("dataOfProductSKU=================>", dataOfProductSKU.data.productVariants.nodes.length);
        if (IS_LOG_2) console.log("count from sync_ftp_csv_Products =============> ", counter.count);

        if (dataOfProductSKU.data.productVariants.nodes.length == 1) {
            const inventoryItemID = dataOfProductSKU.data.productVariants.nodes[0].inventoryItem.id;
            const inventoryLevels = dataOfProductSKU.data.productVariants.nodes[0].inventoryItem.inventoryLevels.edges;
            if (!inventoryLevels.length) {
                console.warn(`No inventoryLevels found for SKU: ${sku}`);
                return;
            }
            const locationID = inventoryLevels[0].node.location.id;
            const delta = qty - dataOfProductSKU.data.productVariants.nodes[0].inventoryQuantity;
            if (IS_LOG) console.log("inventoryItemID=================>", inventoryItemID);
            if (IS_LOG) console.log("locationID=================>", locationID);
            if (IS_LOG) console.log("delta:", delta);
            if (delta) {
                if (IS_LOG) console.log("Delta is not zero, updating inventory of sku:", sku);
            } else {
                if (IS_LOG) console.log("Delta is zero, no need to update inventory of sku:", sku);
            }

            if (locationID) {

                const inventoryAdjustmentMutation = `
                    mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
                        inventoryAdjustQuantities(input: $input) {
                            userErrors {
                                field
                                message
                            }
                            inventoryAdjustmentGroup {
                                createdAt
                                reason
                                changes {
                                    name
                                    delta
                                }
                            }
                        }
                    }
                `;

                await graphqlRequest(shopData, inventoryAdjustmentMutation, {
                    variables: {
                        input: {
                            reason: "correction",
                            name: "available",
                            changes: [
                                {
                                    delta,
                                    inventoryItemId: inventoryItemID,
                                    locationId: locationID
                                }
                            ]
                        }
                    }
                });
            }
        } else if (dataOfProductSKU.data.productVariants.nodes.length > 1) {
            if (IS_LOG) console.log("Multiple variants found hence not updating quantity for SKU:", sku);
        } else {
            if (IS_LOG) console.log("No variant found for SKU:", sku);
        }
    } catch (err) {
        console.error(`From sync_ftp_csv_Products error processing SKU ${sku}:`, err);
    }
}

async function processCsvStreamed(shopData) {
    return new Promise((resolve, reject) => {
        const counter = { count: 0 };

        const stream = fs.createReadStream(LOCAL_CSV_PATH)
            .pipe(csvParser({ separator: ";" }))

        stream.on("data", async (row) => {
            stream.pause();
            processRow(row, shopData, counter)
                .then(() => stream.resume())
                .catch((err) => {
                    console.error("Error occured on stream.on from sync_ftp_csv_Products:", err);
                    stream.resume();
                });
        })

        stream.on("end", () => {
            console.log(`✅ Finished streaming. Total rows processed: ${counter.count}`);
            resolve();
        })

        stream.on("error", (error) => {
            console.error("CSV streaming error from sync_ftp_csv_Products :", error);
            reject(error);
        });
    });
}

export const loader = async () => {
    try {
        const shopData = await prisma.session.findMany();
        // const shopData = [{
        //     shop: "mjfdah-nh.myshopify.com",
        //     accessToken: process.env.SHOPIFY_ACCESS_TOKEN
        // }];
        console.log("API triggered of sync_ftp_csv_Products, shopData............", shopData);

        await downloadCsvFromFtp();
        await processCsvStreamed(shopData);

        return { success: true };
    } catch (error) {
        console.error("Loader error from sync_ftp_csv_Products:", error);
        return new Response(
            JSON.stringify({ error: error, message: "Loader error from sync_ftp_csv_Products"  }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};













/// old code 
// async function parseCsvFromftp() {
//     const results = [];
//     const client = new ftp.Client();
//     client.ftp.verbose = true;

//     try {
//         await client.access({
//             host: FTP_HOST,
//             port: FTP_PORT,
//             user: FTP_USER,
//             password: FTP_PASSWORD,
//             secure: false,
//         });

//         const chunks = [];
//         const writableStream = new Writable({
//             write(chunk, encoding, callback) {
//                 chunks.push(chunk);
//                 callback();
//             }
//         });


//         await client.downloadTo(writableStream, "/ic_ean_CSV.csv");

//         const buffer = Buffer.concat(chunks);

//         const readableStream = Readable.from(buffer);
//         readableStream
//             .pipe(
//                 csvParser({
//                     separator: ";",
//                 })
//             )
//             .on("data", (row) => results.push(row));

//         await finished(readableStream);

//         console.log("Parsed records from parseCsvFromftp:", results.length);
//         return results.map((r) => ({
//             sku: r["PRODUCT_CODE"],
//             qty: r["TOTAL"],
//         }));
//     } catch (error) {
//         console.log("error occurred from parseCsvFromftp on FTP CSV read:", error);
//     } finally {
//         client.close();
//     }
// }


// export const loader = async ({ request }) => {
//     try {
//         // const shopData = await prisma.session.findMany();
//         const shopData = [{
//             shop: "mjfdah-nh.myshopify.com",
//             accessToken: process.env.SHOPIFY_ACCESS_TOKEN
//         }]
//         console.log('shopData===================>', shopData);
//         if (!shopData.length) return json({ message: "No shop data found." });

//         const results = await parseCsvFromftp();
//         // const filePath = path.join(
//         //     process.cwd(),
//         //     "public",
//         //     "csv",
//         //     "variantSKU.csv"
//         // );
//         const skuMap = results.reduce((map, row) => {
//             const qty = parseInt(row.qty, 10) || 0;
//             map[row.sku] = (map[row.sku] || 0) + qty;
//             return map;
//         }, {});

//         // return { results, skuMap: Object.entries(skuMap) }
//         let count = 0;
//         for (const [sku, qty] of Object.entries(skuMap)) {
//             count++
//             const productSKUQuery = `
//                 query ProductVariantsList {
//                     productVariants(first: 10, query: "sku:${sku}") {
//                         nodes {
//                             id
//                             title
//                             inventoryQuantity
//                             inventoryItem {
//                                 id
//                                 inventoryLevels(first: 10) {
//                                     edges {
//                                         node {
//                                             id
//                                             location {
//                                                 id
//                                             }
//                                         }
//                                     }
//                                 }
//                             }
//                         }
//                         pageInfo {
//                             startCursor
//                             endCursor
//                         }
//                     }
//                 }
//             `;

//             const dataOfProductSKU = await graphqlRequest(shopData, productSKUQuery);
//             // console.log("data=================>", data);
//             // console.log("dataOfProductSKU=================>", dataOfProductSKU.data.productVariants.nodes.length);
//             console.log("count----->", count);

//             if (dataOfProductSKU.data.productVariants.nodes.length == 1) {
//                 const inventoryItemID = dataOfProductSKU.data.productVariants.nodes[0].inventoryItem.id;
//                 const locationID = dataOfProductSKU.data.productVariants.nodes[0].inventoryItem.inventoryLevels.edges[0].node.location.id;
//                 const delta = qty - dataOfProductSKU.data.productVariants.nodes[0].inventoryQuantity;
//                 console.log("inventoryItemID=================>", inventoryItemID);
//                 console.log("locationID=================>", locationID);
//                 console.log("delta=================>", delta);
//                 if (delta) {
//                     console.log("Delta is not zero, updating inventory...");
//                 } else {
//                     console.log("Delta is zero, no need to update inventory.");
//                 }


//                 // if (locationID) {

//                 //     const inventoryAdjustmentMutation = `
//                 //         mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
//                 //             inventoryAdjustQuantities(input: $input) {
//                 //                 userErrors {
//                 //                     field
//                 //                     message
//                 //                 }
//                 //                 inventoryAdjustmentGroup {
//                 //                     createdAt
//                 //                     reason
//                 //                     changes {
//                 //                         name
//                 //                         delta
//                 //                     }
//                 //                 }
//                 //             }
//                 //         }
//                 //     `;

//                 //     await graphqlRequest(shopData, inventoryAdjustmentMutation, {
//                 //         variables: {
//                 //             input: {
//                 //                 reason: "correction",
//                 //                 name: "available",
//                 //                 changes: [
//                 //                     {
//                 //                         delta,
//                 //                         inventoryItemId: inventoryItemID,
//                 //                         locationId: locationID
//                 //                     }
//                 //                 ]
//                 //             }
//                 //         }
//                 //     });
//                 // }
//             } else if (dataOfProductSKU.data.productVariants.nodes.length > 1) {
//                 console.log("Multiple variants found hence not updating quantity for SKU:", sku);
//             } else {
//                 console.log("No variant found for SKU:", sku);
//             }
//         }
//         // console.log("CSV parsed from sync_ftp_csv_Products:", results);

//         return { consolidatedData, results };
//     } catch (error) {
//         console.error("error reading CSV from sync_ftp_csv_Products:", error);
//         return { error: error.message }, { status: 500 };
//     }
// };
// end























































// import csvParser from "csv-parser";
// import path from "path";
// import fs from "fs";
// import { PassThrough, Transform } from "stream";
// import { finished } from "stream/promises";
// import { graphqlRequest } from "../component/graphqlRequest";
// import { Readable, Writable } from "stream";
// import ftp from "basic-ftp";
// import { Readable } from "stream";
// import { pipeline } from "stream/promises";

// const {
//     FTP_HOST,
//     FTP_PORT,
//     FTP_USER,
//     FTP_PASSWORD,
// } = process.env;
// // parseCSV from local
// // async function parseCsv(filePath) {
// //     const results = [];

// //     // const file = fs.readFileSync(filePath, "utf8");
// //     // const lines = file.split(/\r\n|\n/);
// //     // console.log("Total lines in file:", lines.length);
// //     // live store products sku: AV1645501,MI567465
// //     const parser = fs
// //         .createReadStream(filePath)
// //         .pipe(csvParser({
// //             separator: ";",
// //             headers: false,
// //             quote: "",        // disabling quotes
// //             skipComments: false,
// //             strict: false
// //         }));

// //     parser.on("data", row => results.push(row));
// //     await finished(parser);
// //     console.log("Parsed records:", results.length);
// //     return results.map(r => ({ sku: r[2], qty: r[3] }));
// // }

// async function parseCsvFromftp() {
//     const results = [];
//     const client = new ftp.Client();
//     client.ftp.verbose = true;

//     try {
//         await client.access({
//             host: FTP_HOST,
//             port: FTP_PORT,
//             user: FTP_USER,
//             password: FTP_PASSWORD,
//             secure: false,
//         });

//         const chunks = [];
//         const writableStream = new Writable({
//             write(chunk, encoding, callback) {
//                 chunks.push(chunk);
//                 callback();
//             }
//         });


//         await client.downloadTo(writableStream, "/ic_ean_CSV.csv");

//         const buffer = Buffer.concat(chunks);

//         const readableStream = Readable.from(buffer);
//         readableStream
//             .pipe(
//                 csvParser({
//                     separator: ";",
//                 })
//             )
//             .on("data", (row) => results.push(row));

//         await finished(readableStream);

//         console.log("Parsed records from parseCsvFromftp:", results.length);
//         return results.map((r) => ({
//             sku: r["PRODUCT_CODE"],
//             qty: r["TOTAL"],
//         }));
//     } catch (error) {
//         console.log("error occurred from parseCsvFromftp on FTP CSV read:", error);
//     } finally {
//         client.close();
//     }
// }



// // async function processCsvBatches(shopData, batchSize = 50) {
// //     const client = new ftp.Client();
// //     await client.access({
// //         host: FTP_HOST,
// //         port: FTP_PORT,
// //         user: FTP_USER,
// //         password: FTP_PASSWORD,
// //         secure: false,
// //     });
// //     const pass = new PassThrough();

// //     // temporary map: sku → qty
// //     let skuMap = {};
// //     let flushProcessCount = 0

// //     // helper to flush current batch
// //     async function flushBatch() {
// //         try {
// //             flushProcessCount++
// //             const skus = Object.keys(skuMap);
// //             console.log("skus.length", skus.length)
// //             console.log("flushProcessCount start", flushProcessCount);
// //             // if (!skus.length) return;
// //             console.log("processing..........................");

// //             // build GraphQL OR-query: "sku:A OR sku:B OR …"
// //             const filter = skus.map(s => `sku:${s}`).join(" OR ");

// //             const productSKUQuery = `
// //                 query ProductVariantsList {
// //                     productVariants(first: 10, query: "${filter}") {
// //                         nodes {
// //                             id
// //                             title
// //                             inventoryQuantity
// //                             inventoryItem {
// //                                 id
// //                                 inventoryLevels(first: 10) {
// //                                     edges {
// //                                         node {
// //                                             id
// //                                             location {
// //                                                 id
// //                                             }
// //                                         }
// //                                     }
// //                                 }
// //                             }
// //                         }
// //                         pageInfo {
// //                             startCursor
// //                             endCursor
// //                         }
// //                     }
// //                 }
// //             `;
// //             const dataOfProductSKU = await graphqlRequest(shopData, productSKUQuery);
// //             console.log("dataOfProductSKU.data.productVariants.nodes.length-------------------->", dataOfProductSKU.data.productVariants.nodes.length);
// //         } catch (error) {
// //             console.log("error occured on flushBatch", error);
// //         } finally {
// //             skuMap = {}; // clear for next batch    
// //         }
// //     }

// //     // Transform: accumulate rows → skuMap, flush when count hits batchSize
// //     const aggregator = new Transform({
// //         objectMode: true,
// //         transform(row, _, cb) {
// //             const sku = row.PRODUCT_CODE;
// //             const qty = parseInt(row.TOTAL, 10) || 0;
// //             skuMap[sku] = (skuMap[sku] || 0) + qty;
// //             if (Object.keys(skuMap).length >= batchSize) {
// //                 // pause, flush batch, then resume
// //                 this.pause();
// //                 flushBatch().then(() => this.resume()).catch(cb);
// //             }
// //             cb();
// //         },
// //         flush(cb) {
// //             // final leftovers
// //             flushBatch().then(() => cb()).catch(cb);
// //         }
// //     });

// //     // kick off download + streaming pipeline
// //     await Promise.all([
// //         client.downloadTo(pass, "/ic_ean_CSV.csv"),           // FTP → pass
// //         pipeline(pass, csvParser({ separator: ";" }), aggregator) // pass → parser → aggregator
// //     ]);

// //     client.close();
// // }

// async function* streamCsvFromFtp(remotePath) {
//     const client = new ftp.Client();
//     await client.access({
//         host: FTP_HOST,
//         port: FTP_PORT,
//         user: FTP_USER,
//         password: FTP_PASSWORD,
//         secure: false,
//     });

//     const pass = new PassThrough();
//     // End the pass stream when download completes
//     client.downloadTo(pass, remotePath)
//         .then(() => pass.end()) // Add this line to end the stream
//         .catch(err => pass.destroy(err));

//     // Configure CSV parser to handle headers if present
//     const parser = pass.pipe(csvParser({ separator: ";", columns: true }));

//     try {
//         for await (const row of parser) {
//             yield row;
//         }
//     } catch (error) {
//         console.log("error occured on streamCsvFromFtp", error);
//     } finally {
//         client.close();
//     }
// }

// async function processCsvWithBatches(shopData, batchSize = 50) {
//     let skuMap = {};
//     let batchCount = 0;

//     // Flush helper: builds OR‐query, performs GraphQL, then clears skuMap
//     async function flushBatch() {
//         try {
//             const skus = Object.keys(skuMap);
//             if (skus.length === 0) return;
//             batchCount++;
//             console.log(`============Flushing batch #${batchCount} (${skus.length} SKUs)==================`);
//             const filter = skus.map(s => `sku:${s}`).join(" OR ");
//             const productSKUQuery = `
//                 query ProductVariantsList {
//                     productVariants(first: 250, query: "${filter}") {
//                         nodes {
//                             id
//                             title
//                             inventoryQuantity
//                             inventoryItem {
//                                 id
//                                 sku
//                                 inventoryLevels(first: 10) {
//                                     edges {
//                                         node {
//                                             id
//                                             location {
//                                                 id
//                                             }
//                                         }
//                                     }
//                                 }
//                             }
//                         }
//                         pageInfo {
//                             startCursor
//                             endCursor
//                         }
//                     }
//                 }
//             `;
//             const dataOfProductSKU = await graphqlRequest(shopData, productSKUQuery);
//             // console.log("dataOfProductSKU.data.productVariants.nodes.length-------------------->", dataOfProductSKU.data.productVariants.nodes.length);
//             if (dataOfProductSKU.data.productVariants.nodes.length) {
//                 for (const node of dataOfProductSKU.data.productVariants.nodes) {
//                     const inventoryItemID = node.inventoryItem.id;
//                     const locationID = node.inventoryItem.inventoryLevels.edges[0].node.location.id;
//                     const quantityFromCSV = skuMap[node.inventoryItem.sku];
//                     // console.log("sku", node.inventoryItem.sku);
//                     // console.log("quantityFromCSV", quantityFromCSV);
//                     const delta = quantityFromCSV - node.inventoryQuantity;
//                     // console.log("inventoryItemID=================>", inventoryItemID);
//                     // console.log("locationID=================>", locationID);
//                     // console.log("delta=================>", delta);
//                     // if (delta) {
//                     //     console.log("Delta is not zero, updating inventory...");
//                     // } else {
//                     //     console.log("Delta is zero, no need to update inventory.");
//                     // }
//                 }
//             }
//             skuMap = {};  // clear for next batch
//         } catch (error) {
//             console.log("error occured on flushBatch", error);
//         }
//     }

//     // Iterate rows one by one
//     for await (const row of streamCsvFromFtp("/ic_ean_CSV.csv")) {
//         const sku = row.PRODUCT_CODE;
//         const qty = parseInt(row.TOTAL, 10) || 0;
//         skuMap[sku] = (skuMap[sku] || 0) + qty;
//         console.log("log outside if block", Object.keys(skuMap).length >= batchSize);
//         console.log("batchSize", batchSize);
//         console.log("Object.keys(skuMap).length", Object.keys(skuMap).length);


//         // Once we hit batchSize distinct SKUs, flush & await
//         if (Object.keys(skuMap).length >= batchSize) {
//             console.log("log inside if block", Object.keys(skuMap).length >= batchSize);
//             await flushBatch();  // backpressure: pause iteration until done :contentReference[oaicite:5]{index=5}
//         }
//     }

//     // Final leftover flush
//     await flushBatch();
//     console.log("All batches processed........");
// }



// export const loader = async ({ request }) => {
//     try {
//         // const shopData = await prisma.session.findMany();
//         const shopData = [{
//             shop: "mjfdah-nh.myshopify.com",
//             accessToken: process.env.SHOPIFY_ACCESS_TOKEN
//         }]
//         console.log('shopData===================>', shopData);
//         if (!shopData.length) return json({ message: "No shop data found." });
//         await processCsvWithBatches(shopData, 50)
//         return { message: "done all data" }
//         // const results = await parseCsvFromftp();
//         // // const filePath = path.join(
//         // //     process.cwd(),
//         // //     "public",
//         // //     "csv",
//         // //     "variantSKU.csv"
//         // // );
//         // const skuMap = results.reduce((map, row) => {
//         //     const qty = parseInt(row.qty, 10) || 0;
//         //     if (!map[row.sku]) {
//         //         map[row.sku] = { ...row, qty };
//         //     } else {
//         //         map[row.sku].qty += qty;
//         //     }
//         //     return map;
//         // }, {});

//         // const consolidatedData = Object.values(skuMap);
//         // return { results, consolidatedData }
//         let count = 0;
//         for (const data of consolidatedData) {
//             count++
//             const productSKUQuery = `
//                 query ProductVariantsList {
//                     productVariants(first: 10, query: "sku:${data?.sku}") {
//                         nodes {
//                             id
//                             title
//                             inventoryQuantity
//                             inventoryItem {
//                                 id
//                                 inventoryLevels(first: 10) {
//                                     edges {
//                                         node {
//                                             id
//                                             location {
//                                                 id
//                                             }
//                                         }
//                                     }
//                                 }
//                             }
//                         }
//                         pageInfo {
//                             startCursor
//                             endCursor
//                         }
//                     }
//                 }
//             `;

//             const dataOfProductSKU = await graphqlRequest(shopData, productSKUQuery);
//             console.log("data=================>", data);
//             console.log("dataOfProductSKU=================>", dataOfProductSKU.data.productVariants.nodes.length);
//             console.log("count----->", count);

//             if (dataOfProductSKU.data.productVariants.nodes.length == 1) {
//                 const inventoryItemID = dataOfProductSKU.data.productVariants.nodes[0].inventoryItem.id;
//                 const locationID = dataOfProductSKU.data.productVariants.nodes[0].inventoryItem.inventoryLevels.edges[0].node.location.id;
//                 const delta = data.qty - dataOfProductSKU.data.productVariants.nodes[0].inventoryQuantity;
//                 console.log("inventoryItemID=================>", inventoryItemID);
//                 console.log("locationID=================>", locationID);
//                 console.log("delta=================>", delta);
//                 if (delta) {
//                     console.log("Delta is not zero, updating inventory...");
//                 } else {
//                     console.log("Delta is zero, no need to update inventory.");
//                 }


//                 // if (locationID) {

//                 //     const inventoryAdjustmentMutation = `
//                 //         mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
//                 //             inventoryAdjustQuantities(input: $input) {
//                 //                 userErrors {
//                 //                     field
//                 //                     message
//                 //                 }
//                 //                 inventoryAdjustmentGroup {
//                 //                     createdAt
//                 //                     reason
//                 //                     changes {
//                 //                         name
//                 //                         delta
//                 //                     }
//                 //                 }
//                 //             }
//                 //         }
//                 //     `;

//                 //     await graphqlRequest(shopData, inventoryAdjustmentMutation, {
//                 //         variables: {
//                 //             input: {
//                 //                 reason: "correction",
//                 //                 name: "available",
//                 //                 changes: [
//                 //                     {
//                 //                         delta,
//                 //                         inventoryItemId: inventoryItemID,
//                 //                         locationId: locationID
//                 //                     }
//                 //                 ]
//                 //             }
//                 //         }
//                 //     });
//                 // }
//             } else if (dataOfProductSKU.data.productVariants.nodes.length > 1) {
//                 console.log("Multiple variants found hence not updating quantity for SKU:", data.sku);
//             } else {
//                 console.log("No variant found for SKU:", data.sku);
//             }
//         }
//         // console.log("CSV parsed from sync_ftp_csv_Products:", results);

//         return { consolidatedData, results };
//     } catch (error) {
//         console.error("error reading CSV from sync_ftp_csv_Products:", error);
//         return { error: error.message }, { status: 500 };
//     }
// };














































// //////////////////////////////////////// old code




// // import csvParser from "csv-parser";
// // import path from "path";
// // import fs from "fs";
// // import { finished } from "stream/promises";
// // import { graphqlRequest } from "../component/graphqlRequest";
// // import prisma from "../db.server";

// // async function parseCsv(filePath) {
// //     const results = [];

// //     // const file = fs.readFileSync(filePath, "utf8");
// //     // const lines = file.split(/\r\n|\n/);
// //     // console.log("Total lines in file:", lines.length);
// //     // live store products sku: AV1645501,MI567465
// //     const parser = fs
// //         .createReadStream(filePath)
// //         .pipe(csvParser({
// //             separator: ";",
// //             headers: false,
// //             quote: "",        // disabling quotes
// //             skipComments: false,
// //             strict: false
// //         }));

// //     parser.on("data", row => results.push(row));
// //     await finished(parser);
// //     console.log("Parsed records:", results.length);
// //     return results.map(r => ({ sku: r[2], qty: r[3] }));
// // }

// // export const loader = async ({ request }) => {
// //     try {
// //         const shopData = await prisma.session.findMany();
// //         console.log('shopData===================>', shopData);
// //         if (!shopData.length) return json({ message: "No shop data found." });
// //         const filePath = path.join(
// //             process.cwd(),
// //             "public",
// //             "csv",
// //             "variantSKU.csv"
// //         );
// //         const results = await parseCsv(filePath);
// //         const skuMap = results.reduce((map, row) => {
// //             const qty = parseInt(row.qty, 10) || 0;
// //             if (!map[row.sku]) {
// //                 map[row.sku] = { ...row, qty };
// //             } else {
// //                 map[row.sku].qty += qty;
// //             }
// //             return map;
// //         }, {});

// //         const consolidatedData = Object.values(skuMap);

// //         for (const data of consolidatedData) {
// //             const productSKUQuery = `
// //                 query ProductVariantsList {
// //                     productVariants(first: 10, query: "sku:${data?.sku}") {
// //                         nodes {
// //                             id
// //                             title
// //                             inventoryQuantity
// //                             inventoryItem {
// //                                 id
// //                                 inventoryLevels(first: 10) {
// //                                     edges {
// //                                         node {
// //                                             id
// //                                             location {
// //                                                 id
// //                                             }
// //                                         }
// //                                     }
// //                                 }
// //                             }
// //                         }
// //                         pageInfo {
// //                             startCursor
// //                             endCursor
// //                         }
// //                     }
// //                 }
// //             `;

// //             const dataOfProductSKU = await graphqlRequest(shopData, productSKUQuery);
// //             console.log("data=================>", data);
// //             console.log("dataOfProductSKU=================>", dataOfProductSKU.data.productVariants.nodes.length);

// //             if (dataOfProductSKU.data.productVariants.nodes.length == 1) {
// //                 const inventoryItemID = dataOfProductSKU.data.productVariants.nodes[0].inventoryItem.id;
// //                 const locationID = dataOfProductSKU.data.productVariants.nodes[0].inventoryItem.inventoryLevels.edges[0].node.location.id;
// //                 const delta = data.qty - dataOfProductSKU.data.productVariants.nodes[0].inventoryQuantity;
// //                 console.log("inventoryItemID=================>", inventoryItemID);
// //                 console.log("locationID=================>", locationID);
// //                 console.log("delta=================>", delta);
// //                 if (delta) {
// //                     console.log("Delta is not zero, updating inventory...");
// //                 } else {
// //                     console.log("Delta is zero, no need to update inventory.");
// //                 }                

// //                 if (locationID) {

// //                     const inventoryAdjustmentMutation = `
// //                         mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
// //                             inventoryAdjustQuantities(input: $input) {
// //                                 userErrors {
// //                                     field
// //                                     message
// //                                 }
// //                                 inventoryAdjustmentGroup {
// //                                     createdAt
// //                                     reason
// //                                     changes {
// //                                         name
// //                                         delta
// //                                     }
// //                                 }
// //                             }
// //                         }
// //                     `;

// //                     await graphqlRequest(shopData, inventoryAdjustmentMutation, {
// //                         variables: {
// //                             input: {
// //                                 reason: "correction",
// //                                 name: "available",
// //                                 changes: [
// //                                     {
// //                                         delta,
// //                                         inventoryItemId: inventoryItemID,
// //                                         locationId: locationID
// //                                     }
// //                                 ]
// //                             }
// //                         }
// //                     });
// //                 }
// //             } else if (dataOfProductSKU.data.productVariants.nodes.length > 1) {
// //                 console.log("Multiple variants found hence not updating quantity for SKU:", data.sku);
// //             } else {
// //                 console.log("No variant found for SKU:", data.sku);
// //             }
// //         }
// //         // console.log("CSV parsed:", results);
// //         return { consolidatedData, results };
// //     } catch (error) {
// //         console.error("error reading CSV:", error);
// //         return { error: error.message }, { status: 500 };
// //     }
// // };
