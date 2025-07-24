const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const admin = require('firebase-admin');

// Khởi tạo Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert('./serviceAccountKey.json'),
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Helper function thay thế waitForTimeout
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Optimized parsePrice function - fix lỗi DMX
function parsePrice(priceText) {
    if (!priceText || priceText === 'Không có' || priceText === 'Không hiển thị') return null;
    
    // Handle các format giá khác nhau:
    // DMX: "10.710.000₫" hoặc data-price="10710000"
    // WellHome: "18,825,000₫"  
    // QuangHanh: "8,100,000đ"
    
    let cleanPrice = priceText.toString();
    
    // Remove currency symbols
    cleanPrice = cleanPrice.replace(/[₫đ\s]/g, '');
    
    // Handle Vietnamese thousand separators
    if (cleanPrice.includes('.') && cleanPrice.includes(',')) {
        // Format: 1.234,56 -> remove dots, comma as decimal
        cleanPrice = cleanPrice.replace(/\./g, '').replace(',', '.');
    } else if (cleanPrice.includes('.')) {
        // Format: 10.710.000 -> remove all dots (thousand separators)
        cleanPrice = cleanPrice.replace(/\./g, '');
    } else if (cleanPrice.includes(',')) {
        // Format: 18,825,000 -> remove commas (thousand separators)  
        cleanPrice = cleanPrice.replace(/,/g, '');
    }
    
    const price = parseFloat(cleanPrice);
    
    if (!isNaN(price) && price > 0) {
        console.log(`💰 Price parsed: "${priceText}" -> ${price}`);
        return price;
    }
    
    console.log(`❌ Could not parse price: "${priceText}"`);
    return null;
}

// Optimized DMX scraper - sử dụng strategy đã biết hoạt động
async function fetchPriceFromDienmayxanh(page, sku) {
    const url = `https://www.dienmayxanh.com/search?key=${sku}`;
    console.log(`🔍 Đang cào Điện Máy Xanh - SKU: ${sku}`);
    
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(8000); // Tăng delay cho DMX
        
        // Strategy tối ưu: Đi thẳng vào "Any item with data-name" vì đã biết hoạt động
        const containers = await page.$$("a[data-name], .item[data-name]");
        console.log(`Found ${containers.length} DMX containers`);
        
        for (const container of containers) {
            try {
                const name = await page.evaluate(el => el.getAttribute('data-name'), container);
                
                // Check if this is the right product
                if (name && (name.toUpperCase().includes(sku.toUpperCase()) || 
                              name.toUpperCase().includes('BOSCH'))) {
                    
                    // Strategy 1: Try data-price attribute first
                    let priceNum = null;
                    const dataPriceRaw = await page.evaluate(el => el.getAttribute('data-price'), container);
                    if (dataPriceRaw) {
                        priceNum = parseFloat(dataPriceRaw);
                    }
                    
                    // Strategy 2: Try strong.price text content
                    if (!priceNum || priceNum < 100000) {
                        try {
                            const priceEl = await container.$("strong.price, .price strong");
                            if (priceEl) {
                                const priceText = await page.evaluate(el => el.textContent.trim(), priceEl);
                                priceNum = parsePrice(priceText);
                            }
                        } catch (e) {
                            // Continue with other strategies
                        }
                    }
                    
                    // Validate price
                    if (priceNum && priceNum > 100000) {
                        const priceFormatted = new Intl.NumberFormat('vi-VN').format(priceNum) + '₫';
                        
                        const brand = await page.evaluate(el => el.getAttribute('data-brand'), container);
                        const category = await page.evaluate(el => el.getAttribute('data-cate'), container);
                        
                        console.log(`✅ DMX Success: ${name} - ${priceFormatted} (${priceNum})`);
                        
                        return {
                            website: 'Điện Máy Xanh',
                            sku: sku,
                            name: name,
                            price: priceFormatted,
                            rawPrice: priceNum,
                            brand: brand,
                            category: category,
                            status: 'Còn hàng'
                        };
                    }
                }
            } catch (containerError) {
                continue;
            }
        }
        
        console.log(`❌ DMX: No valid product found for ${sku}`);
        return {
            website: 'Điện Máy Xanh',
            sku: sku,
            name: null,
            price: null,
            rawPrice: null,
            brand: null,
            category: null,
            status: 'Không tìm thấy'
        };
        
    } catch (error) {
        console.log(`❌ Error scraping DMX for ${sku}:`, error.message);
        return {
            website: 'Điện Máy Xanh',
            sku: sku,
            name: null,
            price: null,
            rawPrice: null,
            brand: null,
            category: null,
            status: 'Lỗi kết nối'
        };
    }
}

// Optimized WellHome scraper - strategy đã hoạt động tốt
async function fetchPriceFromWellhome(page, sku) {
    const searchUrl = `https://wellhome.asia/search?type=product&q=${sku}`;
    console.log(`🔍 Đang cào WellHome - SKU: ${sku}`);
    
    try {
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(3000);
        
        // Direct strategy - đã biết hoạt động
        const productData = await page.evaluate(() => {
            try {
                const product = document.querySelector(".product-inner");
                if (product) {
                    const nameEl = product.querySelector("h3");
                    const name = nameEl ? nameEl.textContent.trim() : null;
                    
                    let price = "Không hiển thị";
                    try {
                        const priceEl = product.querySelector("span.price");
                        if (priceEl) {
                            price = priceEl.textContent.trim();
                        }
                    } catch (e) {
                        price = "Không hiển thị";
                    }
                    
                    return { name, price, found: true };
                }
                return { found: false };
            } catch (error) {
                return { found: false, error: error.message };
            }
        });
        
        if (productData.found) {
            const priceNum = parsePrice(productData.price);
            
            console.log(`✅ WellHome Success: ${productData.name} - ${productData.price}`);
            
            return {
                website: 'WellHome',
                sku: sku,
                name: productData.name,
                price: productData.price,
                rawPrice: priceNum,
                brand: 'Bosch',
                category: 'Gia dụng',
                status: 'Còn hàng'
            };
        } else {
            console.log(`❌ WellHome: No product found for ${sku}`);
            return {
                website: 'WellHome',
                sku: sku,
                name: null,
                price: null,
                rawPrice: null,
                brand: null,
                category: null,
                status: 'Không tìm thấy'
            };
        }
        
    } catch (error) {
        console.log(`❌ Error scraping WellHome for ${sku}:`, error.message);
        return {
            website: 'WellHome',
            sku: sku,
            name: null,
            price: null,
            rawPrice: null,
            brand: null,
            category: null,
            status: 'Lỗi kết nối'
        };
    }
}

// Optimized QuangHanh scraper - đi thẳng strategy 3 vì đã biết hoạt động
async function fetchPriceFromQuanghanh(page, sku) {
    const searchUrl = `https://dienmayquanghanh.com/tu-khoa?q=${sku}`;
    console.log(`🔍 Đang cào Điện Máy Quang Hạnh - SKU: ${sku}`);
    
    try {
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(4000);
        
        // Direct strategy 3 - "Tìm trực tiếp prPrice" đã biết hoạt động 100%
        const result = await page.evaluate((sku) => {
            const priceElements = document.querySelectorAll('.prPrice');
            if (priceElements.length > 0) {
                const priceElement = priceElements[0];
                const price = priceElement.textContent.trim();
                
                if (price) {
                    let name = `Sản phẩm ${sku}`;
                    try {
                        const parent = priceElement.parentElement;
                        const titleEl = parent.querySelector('h3, .title');
                        if (titleEl) {
                            name = titleEl.textContent.trim();
                        }
                    } catch (e) {
                        // Keep default name
                    }
                    
                    return { name, price, found: true };
                }
            }
            return { found: false };
        }, sku);
        
        if (result.found) {
            const priceNum = parsePrice(result.price);
            
            console.log(`✅ Quang Hạnh Success: ${result.name} - ${result.price}`);
            
            return {
                website: 'Điện Máy Quang Hạnh',
                sku: sku,
                name: result.name,
                price: result.price,
                rawPrice: priceNum,
                brand: 'Bosch',
                category: 'Gia dụng',
                status: 'Còn hàng'
            };
        }
        
        console.log(`❌ Quang Hạnh: No product found for ${sku}`);
        return {
            website: 'Điện Máy Quang Hạnh',
            sku: sku,
            name: null,
            price: null,
            rawPrice: null,
            brand: null,
            category: null,
            status: 'Không tìm thấy'
        };
        
    } catch (error) {
        console.log(`❌ Error scraping Quang Hạnh for ${sku}:`, error.message);
        return {
            website: 'Điện Máy Quang Hạnh',
            sku: sku,
            name: null,
            price: null,
            rawPrice: null,
            brand: null,
            category: null,
            status: 'Lỗi kết nối'
        };
    }
}

// API endpoint với data structure fixed
app.post('/api/scrape', async (req, res) => {
    console.log('==== BẮT ĐẦU CÀO GIÁ TỪ CẢ 3 WEBSITE ====');
    
    const { products, suppliers, urlMappings } = req.body;
    const allResults = [];
    
    let browser;
    
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage', 
                '--disable-gpu',
                '--window-size=1920,1080',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            ]
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        
        for (const product of products) {
            const sku = product.code;
            console.log(`\n🚀 Processing SKU: ${sku}`);
            
            // Cào từ Điện Máy Xanh - sử dụng rawPrice
            const dmxResult = await fetchPriceFromDienmayxanh(page, sku);
            allResults.push({
                sku: dmxResult.sku,
                scrape_time: new Date().toISOString(),
                supplier: dmxResult.website,
                supplier_id: suppliers.find(s => s.name.includes('Điện Máy Xanh'))?.id || 'dmx',
                product_name: dmxResult.name,
                price: dmxResult.rawPrice, // FIX: Sử dụng rawPrice thay vì parsePrice()
                price_formatted: dmxResult.price,
                status: dmxResult.name ? (dmxResult.rawPrice ? 'found_with_price' : 'found_no_price') : 'no_info',
                url_scraped: `https://www.dienmayxanh.com/search?key=${sku}`,
                currency: 'VND'
            });
            
            // Cào từ WellHome - sử dụng rawPrice
            const whResult = await fetchPriceFromWellhome(page, sku);
            allResults.push({
                sku: whResult.sku,
                scrape_time: new Date().toISOString(),
                supplier: whResult.website,
                supplier_id: suppliers.find(s => s.name.includes('WellHome'))?.id || 'wh',
                product_name: whResult.name,
                price: whResult.rawPrice, // FIX: Sử dụng rawPrice
                price_formatted: whResult.price,
                status: whResult.name ? (whResult.rawPrice ? 'found_with_price' : 'found_no_price') : 'no_info',
                url_scraped: `https://wellhome.asia/search?type=product&q=${sku}`,
                currency: 'VND'
            });
            
            // Cào từ Điện Máy Quang Hạnh - sử dụng rawPrice
            const qhResult = await fetchPriceFromQuanghanh(page, sku);
            allResults.push({
                sku: qhResult.sku,
                scrape_time: new Date().toISOString(),
                supplier: qhResult.website,
                supplier_id: suppliers.find(s => s.name.includes('Quang Hạnh'))?.id || 'qh',
                product_name: qhResult.name,
                price: qhResult.rawPrice, // FIX: Sử dụng rawPrice
                price_formatted: qhResult.price,
                status: qhResult.name ? (qhResult.rawPrice ? 'found_with_price' : 'found_no_price') : 'no_info',
                url_scraped: `https://dienmayquanghanh.com/tu-khoa?q=${sku}`,
                currency: 'VND'
            });
            
            await delay(2000);
        }
        
        // Thống kê kết quả
        const successfulDmx = allResults.filter(r => r.supplier === 'Điện Máy Xanh' && r.status === 'found_with_price').length;
        const successfulWh = allResults.filter(r => r.supplier === 'WellHome' && r.status === 'found_with_price').length; 
        const successfulQh = allResults.filter(r => r.supplier === 'Điện Máy Quang Hạnh' && r.status === 'found_with_price').length;
        
        console.log('\n==== THỐNG KÊ KẾT QUẢ ====');
        console.log(`✅ Điện Máy Xanh: ${successfulDmx}/${products.length} SKU thành công`);
        console.log(`✅ WellHome: ${successfulWh}/${products.length} SKU thành công`);
        console.log(`✅ Điện Máy Quang Hạnh: ${successfulQh}/${products.length} SKU thành công`);
        console.log(`📊 Tổng cộng: ${successfulDmx + successfulWh + successfulQh}/${products.length * 3} kết quả`);
        
        res.json(allResults);
        
    } catch (error) {
        console.error('❌ Scraping error:', error);
        res.status(500).json({ error: error.message, stack: error.stack });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

// Hàm autoScrape để chạy tự động
async function autoScrape() {
    console.log('==== AUTO SCRAPING BẮT ĐẦU ====');
    
    let browser;
    try {
        // Load data từ Firebase
        const productsSnap = await db.collection('products').get();
        const products = productsSnap.docs.map(doc => doc.data());
        
        const suppliersSnap = await db.collection('suppliers').get();
        const suppliers = suppliersSnap.docs.map(doc => doc.data());
        
        const urlMappingsSnap = await db.collection('urlMappings').get();
        const urlMappings = urlMappingsSnap.docs.map(doc => doc.data());
        
        const allResults = [];
        
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage', 
                '--disable-gpu',
                '--window-size=1920,1080',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            ]
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        
        for (const product of products) {
            const sku = product.code;
            console.log(`\n🚀 Processing SKU: ${sku}`);
            
            const dmxResult = await fetchPriceFromDienmayxanh(page, sku);
            allResults.push({
                sku: dmxResult.sku,
                scrape_time: new Date().toISOString(),
                supplier: dmxResult.website,
                supplier_id: suppliers.find(s => s.name.includes('Điện Máy Xanh'))?.id || 'dmx',
                product_name: dmxResult.name,
                price: dmxResult.rawPrice,
                price_formatted: dmxResult.price,
                status: dmxResult.name ? (dmxResult.rawPrice ? 'found_with_price' : 'found_no_price') : 'no_info',
                url_scraped: `https://www.dienmayxanh.com/search?key=${sku}`,
                currency: 'VND'
            });
            
            const whResult = await fetchPriceFromWellhome(page, sku);
            allResults.push({
                sku: whResult.sku,
                scrape_time: new Date().toISOString(),
                supplier: whResult.website,
                supplier_id: suppliers.find(s => s.name.includes('WellHome'))?.id || 'wh',
                product_name: whResult.name,
                price: whResult.rawPrice,
                price_formatted: whResult.price,
                status: whResult.name ? (whResult.rawPrice ? 'found_with_price' : 'found_no_price') : 'no_info',
                url_scraped: `https://wellhome.asia/search?type=product&q=${sku}`,
                currency: 'VND'
            });
            
            const qhResult = await fetchPriceFromQuanghanh(page, sku);
            allResults.push({
                sku: qhResult.sku,
                scrape_time: new Date().toISOString(),
                supplier: qhResult.website,
                supplier_id: suppliers.find(s => s.name.includes('Quang Hạnh'))?.id || 'qh',
                product_name: qhResult.name,
                price: qhResult.rawPrice,
                price_formatted: qhResult.price,
                status: qhResult.name ? (qhResult.rawPrice ? 'found_with_price' : 'found_no_price') : 'no_info',
                url_scraped: `https://dienmayquanghanh.com/tu-khoa?q=${sku}`,
                currency: 'VND'
            });
            
            await delay(2000);
        }
        
        // Thống kê kết quả
        const successfulDmx = allResults.filter(r => r.supplier === 'Điện Máy Xanh' && r.status === 'found_with_price').length;
        const successfulWh = allResults.filter(r => r.supplier === 'WellHome' && r.status === 'found_with_price').length; 
        const successfulQh = allResults.filter(r => r.supplier === 'Điện Máy Quang Hạnh' && r.status === 'found_with_price').length;
        
        console.log('\n==== THỐNG KÊ KẾT QUẢ ====');
        console.log(`✅ Điện Máy Xanh: ${successfulDmx}/${products.length} SKU thành công`);
        console.log(`✅ WellHome: ${successfulWh}/${products.length} SKU thành công`);
        console.log(`✅ Điện Máy Quang Hạnh: ${successfulQh}/${products.length} SKU thành công`);
        console.log(`📊 Tổng cộng: ${successfulDmx + successfulWh + successfulQh}/${products.length * 3} kết quả`);
        
        // Lưu vào Firebase
        const batch = db.batch();
        const sessionId = Date.now().toString();
        const session = {
            session_id: sessionId,
            start_time: new Date().toISOString(),
            total_products: products.length,
            total_suppliers: suppliers.length,
            total_results: allResults.length,
            success_count: allResults.filter(r => r.status === 'found_with_price').length,
            status: 'completed'
        };
        batch.set(db.collection('scrapeSessions').doc(sessionId), session);
        
        allResults.forEach((result, index) => {
            batch.set(db.collection('priceData').doc(`${sessionId}_${index}`), result);
        });
        
        await batch.commit();
        console.log('✅ Auto scrape hoàn thành và lưu vào Firebase');
        
    } catch (error) {
        console.error('❌ Auto scrape error:', error);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// Endpoint để trigger autoScrape từ cron hoặc GitHub Actions
app.post('/api/auto-scrape', async (req, res) => {
    await autoScrape();
    res.json({ message: 'Auto scrape hoàn thành' });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Optimized Scraper API is running!',
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Optimized Scraper API running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
    console.log('🔍 Ready to scrape with optimized strategies!');
});

process.on('SIGINT', () => {
    console.log('🛑 Shutting down gracefully...');
    process.exit(0);
});
