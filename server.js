const express = require('express');
const ExcelJS = require("exceljs");
const app = express();
const path = require('path');
const fs = require('fs');
const { createCanvas } = require('canvas');
const bodyParser = require('body-parser');
const oracledb = require('oracledb');
const ftp = require('basic-ftp');
const session = require('express-session');
const XLSX = require('xlsx');
const puppeteer = require("puppeteer");

oracledb.initOracleClient();

// 정적 파일 제공 설정 및 캐시 제어
app.use('/public', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
}, express.static(path.join(__dirname, 'public')));

app.use('/tailwindcss', express.static(path.join(__dirname, 'tailwindcss')));


// const cacheControl = (req, res, next) => {
//     res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
//     res.setHeader('Pragma', 'no-cache');
//     res.setHeader('Expires', '0');
//     next();
// };

// app.use('/public', cacheControl);
// app.use('/public', express.static(path.join(__dirname, 'public')));

// app.use('/public', cacheControl, express.static(path.join(__dirname, 'public')));

const dbConfig1 = {
    user: 'RPA',
    password: 'rpa01!',
    connectString: '192.168.223.13:1521/ERPSIMAX'
};

async function downloadFileFromFTP(remotePath, localPath) {
    const client = new ftp.Client();
    client.ftp.verbose = true;
    try {
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });
        await client.downloadTo(localPath, remotePath);
    } catch (error) {
        console.error('FTP download error:', error);
        throw error;
    }
    client.close();
}

async function fetchImagesFromFTP(lotId) {
    const client = new ftp.Client();
    client.ftp.verbose = true;
    try {
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });

        const basePath = `RPA/probemark_Image/CONVERSION/${lotId}/`;
        const folders = await client.list(basePath);
        if (folders.length === 0) {
            throw new Error('No folders found');
        }
        const latestFolder = folders.sort((a, b) => b.name.localeCompare(a.name))[0].name;
        const lotPath = `${basePath}${latestFolder}/`;

        const subFolders = await client.list(lotPath);
        if (subFolders.length === 0) {
            throw new Error('No subfolders found');
        }
        const latestSubFolder = subFolders.sort((a, b) => b.name.localeCompare(a.name))[0].name;
        const imagePath = `${lotPath}${latestSubFolder}/`;

        const files = await client.list(imagePath);
        //const bmpFiles = files.filter(file => file.name.endsWith('.bmp'));
        const bmpFiles = files.filter(file => file.name.endsWith('.bmp') || file.name.endsWith('.jpg'));

        return bmpFiles.map(file => ({
            name: file.name,
            path: `ftp://192.168.223.23${imagePath}${file.name}`
        }));
    } catch (error) {
        console.error('FTP fetch error:', error);
        throw error;
    } finally {
        client.close();
    }
}


app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());

app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        httpOnly: true,
        maxAge: 3600000
    }
}));

app.listen(8080, '0.0.0.0', function () {
    console.log('Server is running on http://<server-ip>:8080');
});

function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    } else {
        res.redirect('/login_RPA');
    }
}

app.get('/login_RPA', function (req, res) {
    res.sendFile(path.join(__dirname, 'RPA_login.html'));
});

app.get('/login', async function (req, res) {
    const { userId, password } = req.query;

    console.log('Login request received:', { userId, password });

    const query = `
        SELECT USER_ID, USER_NAME, GW_DEPT_NAME, GW_USER_POSITION,
               'nepes_' || SUBSTR(user_id, -4) AS USER_PW
        FROM (
            SELECT a.*, 
                   ROW_NUMBER() OVER (PARTITION BY a.USER_ID, a.USER_NAME ORDER BY a.GW_IF_TIME DESC) AS rn
            FROM RPA_ADMIN.view_userinfo a
        ) tmp
        WHERE rn = 1
          --AND EMAIL IS NOT NULL
          AND GW_DEPT_NAME in ('제조1파트','제조2파트','하이퍼오토메이션팀')
          AND GW_USER_POSITION NOT LIKE 'S%'
          AND USER_ID = :userId
    `;

    try {
        const connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(query, [userId]);
        await connection.close();

        console.log('Database query result:', result);

        if (result.rows.length === 0) {
            res.json({ success: false, message: '계정 정보가 없습니다. 관리자에게 문의하세요.' });
        } else {
            const dbUserPw = result.rows[0][4];
            const userName = result.rows[0][1];
            console.log('Generated USER_PW:', dbUserPw);
            if (dbUserPw === password) {
                req.session.userId = userId;
                req.session.userName = userName; // USER_NAME을 세션에 저장
                res.json({ success: true });
            } else {
                res.json({ success: false, message: 'PASSWORD를 확인해주세요.' });
            }
        }
    } catch (error) {
        console.error('Database error:', error.message);
        res.status(500).json({ success: false, message: `Database error: ${error.message}` });
    }
});


// 사용자 정보를 반환하는 API 엔드포인트 추가
app.get('/user_info', function (req, res) {
    if (req.session.userName) {
        res.json({ userName: req.session.userName });
    } else {
        res.status(401).json({ message: '로그인 필요' });
    }
});

app.post('/logout', function(req, res) {
    req.session.destroy(function(err) {
        if(err) {
            console.error('세션 삭제 중 오류 발생:', err);
            res.status(500).json({ success: false, message: '로그아웃 실패' });
        } else {
            res.clearCookie('connect.sid');
            res.json({ success: true, message: '로그아웃 성공' });
        }
    });
});

app.use('/Ark_RPA_Control_system', isAuthenticated);

app.get('/Ark_RPA_Control_system', function (req, res) {
    res.sendFile(path.join(__dirname, 'RPA_index.html'));
});

// Report.html 파일을 제공하는 엔드포인트 추가
app.get('/report', function (req, res) {
    res.sendFile(path.join(__dirname, 'Report.html'));
});


app.get('/getSummaryReport', async function (req, res) {
    let connection;
    try {
        // Oracle DB 연결
        connection = await oracledb.getConnection(dbConfig1);
        
        // 결과를 객체로 변환하도록 설정
        const originalOutFormat = oracledb.outFormat;
        oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

        // 데이터베이스에서 요약 보고서 데이터 조회
        const result = await connection.execute(`
            SELECT ID,
                   START_TIME,
                   END_TIME,
                   RUN_TIME,
                   SORT_TYPE,
                   MACHINE,
                   LOT_ID,
                   SLOT,
                   STEP,
                   DEVICE_PPID,
                   TOP_POSITION,
                   CENTER_POSITION,
                   BOTTOM_POSITION,
                   LEFT_POSITION,
                   RIGHT_POSITION,
                   SETUP_DIE,
                   OD_VALUE,
                   FIRST_DIE_XY,
                   WAFER_LOADING_POS_X,
                   WAFER_LOADING_POS_Y,
                   WAFER_LOADING_POS_Z,
                   POLYGON_TYPE,
                   VERTEX_LENGTH,
                   SANDING_COUNT,
                   SANDING_OD,
                   PROBE_CARD_DEPTH,
                   WAFER_ALIGN_VALUE_X,
                   WAFER_ALIGN_VALUE_Y,
                   PIN_ALIGN_VALUE_Z,
                   WAFER_SETUP_FLATNESS,
                   CREATED_DATE
            
            FROM RPA_ADMIN.summareport
            ORDER BY ID ASC
        `);

        // 원래 형식으로 복원
        oracledb.outFormat = originalOutFormat;
        
        if (!result.rows || result.rows.length === 0) {
            return res.status(404).send('데이터가 없습니다.');
        }

        // 데이터를 JSON 형식으로 반환
        res.json(result.rows);

    } catch (error) {
        console.error('Oracle DB에서 데이터를 가져오는 중 오류 발생:', error);
        res.status(500).send('데이터베이스 조회 중 오류가 발생했습니다.');
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error('DB 연결 종료 중 오류:', err);
            }
        }
    }
});

app.get('/getImage', function (req, res) {
    const filePath = path.join(__dirname, 'nepesark_2-removebg-preview.png');
    fs.readFile(filePath, function (err, data) {
        if (err) {
            console.error('File read error:', err);
            res.status(500).send('파일을 읽는 중 오류가 발생했습니다.');
        } else {
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Content-Disposition', 'inline; filename=nepesark_2-removebg-preview.png');
            res.send(data);
        }
    });
});

app.get('/getImage2', function (req, res) {
    const filePath = path.join(__dirname, 'RPA_image.jpg');
    fs.readFile(filePath, function (err, data) {
        if (err) {
            console.error('File read error:', err);
            res.status(500).send('파일을 읽는 중 오류가 발생했습니다.');
        } else {
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Content-Disposition', 'inline; filename=nepesark_2.jpg');
            res.send(data);
        }
    });
});


async function getDataFromDB1() {
    let connection;
    try {
        connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(`
            SELECT 
                i.STATUS,
                i.EQPID,
                i.DEVICE,
                i.LOT_ID,
                i.STEP_ID,
                i.PC_ID,
                i.PB_ID,
                i.USER_ID,
                TO_CHAR(r.START_TIME, 'YYYY-MM-DD HH24:MI:SS') AS DATE_,
                i.IP,
                ROWNUM,
                r.RPA_STATUS,
                r.PROGRESS,
                r.PG_DETAIL,
                r.FINALLY,
                r.ERROR_ME,
                r.ACTION_SORT,
                r.ACTION_COMMENT,
                r.USERID
            FROM 
                (SELECT 
                    STATUS, EQPID, DEVICE, LOT_ID, STEP_ID, PC_ID, PB_ID, USER_ID, DATE_, IP,
                    ROW_NUMBER() OVER (PARTITION BY EQPID ORDER BY DATE_ DESC) AS rn
                FROM RPA_ADMIN.INTERFACE) i
            LEFT JOIN 
                (SELECT 
                    EQP_ID, SORT_STATUS, LOT_ID, RPA_STATUS, PROGRESS, PG_DETAIL, FINALLY, USERID, START_TIME,ERROR_ME,ACTION_SORT,ACTION_COMMENT,
                    ROW_NUMBER() OVER (PARTITION BY EQP_ID ORDER BY START_TIME DESC) AS rn
                FROM RPA_ADMIN.RPA) r
            ON i.EQPID = r.EQP_ID 
            AND i.STATUS = r.SORT_STATUS 
            AND i.LOT_ID = r.LOT_ID
            WHERE i.rn = 1 AND r.rn = 1 AND r.FINALLY NOT IN ('Ok', 'No')
            ORDER BY i.EQPID ASC
        `);
        return result.rows.map(row => ({
            STATUS: row[0],
            EQPID: row[1],
            DEVICE: row[2],
            LOT_ID: row[3],
            STEP_ID: row[4],
            PC_ID: row[5],
            PB_ID: row[6],
            USER_ID: row[7],
            DATE_: row[8],
            IP: row[9],
            ROWNUM: row[10],
            RPA_STATUS: row[11],
            PROGRESS: row[12],
            PG_DETAIL: row[13],
            FINALLY: row[14], // FINALLY 컬럼 추가
            ACTION_SORT: row[15],
            ACTION_COMMENT: row[16],
            USERID: row[17]
        }));
    } catch (err) {
        console.error(err);
        throw err;
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error(err);
            }
        }
    }
}

async function getWaitDataFromDB1() {
    let connection;
    try {
        connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(`
            SELECT 
                i.STATUS,
                i.EQPID,
                i.DEVICE,
                i.LOT_ID,
                i.STEP_ID,
                i.PC_ID,
                i.PB_ID,
                i.USER_ID,
                TO_CHAR(r.START_TIME, 'YYYY-MM-DD HH24:MI:SS') AS DATE_,
                i.IP,
                ROWNUM,
                r.RPA_STATUS,
                r.PROGRESS,
                r.PG_DETAIL,
                r.FINALLY,
                r.ACTION_SORT,
                r.ACTION_COMMENT,
                r.USERID
            FROM 
                (SELECT 
                    STATUS, EQPID, DEVICE, LOT_ID, STEP_ID, PC_ID, PB_ID, USER_ID, DATE_, IP,
                    ROW_NUMBER() OVER (PARTITION BY EQPID ORDER BY DATE_ DESC) AS rn
                FROM RPA_ADMIN.INTERFACE) i
            LEFT JOIN 
                (SELECT 
                    EQP_ID, SORT_STATUS, LOT_ID, RPA_STATUS, PROGRESS, PG_DETAIL, FINALLY, USERID, START_TIME, ACTION_SORT,, ACTION_COMMENT,
                    ROW_NUMBER() OVER (PARTITION BY EQP_ID ORDER BY START_TIME DESC) AS rn
                FROM RPA_ADMIN.RPA) r
            ON i.EQPID = r.EQP_ID 
            AND i.STATUS = r.SORT_STATUS 
            --AND i.LOT_ID = r.LOT_ID
            WHERE i.rn = 1 AND r.rn = 1 AND r.FINALLY NOT IN ('Ok', 'No')
            ORDER BY i.EQPID ASC
        `);
        return result.rows.map(row => ({
            STATUS: row[0],
            EQPID: row[1],
            DEVICE: row[2],
            LOT_ID: row[3],
            STEP_ID: row[4],
            PC_ID: row[5],
            PB_ID: row[6],
            USER_ID: row[7],
            DATE_: row[8],
            IP: row[9],
            ROWNUM: row[10],
            RPA_STATUS: row[11],
            PROGRESS: row[12],
            PG_DETAIL: row[13],
            FINALLY: row[14], // FINALLY 컬럼 추가
            ACTION_SORT: row[15],
            ACTION_COMMENT: row[16],
            USERID: row[17]
        }));
    } catch (err) {
        console.error(err);
        throw err;
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error(err);
            }
        }
    }
}

app.get('/getMonitoringData', async function (req, res) {
    try {
        const data = await getDataFromDB1();
        res.json(data);
    } catch (err) {
        res.status(500).send('Error fetching data');
    }
});

app.get('/getWaitData', async function (req, res) {
    try {
        const data = await getWaitDataFromDB1();
        res.json(data);
    } catch (err) {
        res.status(500).send('Error fetching data');
    }
});

app.get('/viewExcelSheet', async function (req, res) {
    if (!globalItem || !globalItem.STATUS || !globalItem.LOT_ID || !globalItem.EQPID) {
        return res.status(400).send('STATUS, LOT_ID 또는 DEVICE 정보가 설정되지 않았습니다.');
    }

    // 여기요!! - basePath에 EQPID 폴더 경로 추가
    const basePath = `RPA/Report/${globalItem.STATUS}/${globalItem.EQPID}/`;
    const client = new ftp.Client();
    client.ftp.verbose = true;
    // 여기요!! - 리눅스 FTP 서버용 패시브 모드 설정
    client.ftp.pasv = true;
    const localPath = path.join(__dirname, 'temp.xlsx');

    try {
        await client.access({
            host: "192.168.223.23", // 변경된 FTP 서버 호스트
            user: "hyperauto",      // 변경된 사용자 이름
            password: "Gkdlvj123!@#", // 변경된 비밀번호
            secure: false
        });

        // 해당 경로의 파일 목록 가져오기
        console.log(`Files path: ${basePath}`); // 경로 로깅
        const files = await client.list(basePath);
        console.log('Files in directory:', files); // 파일 목록 로깅
        
        // 여기요!! - 리눅스 파일시스템 대응: 디렉토리 제외 필터링 추가
        const matchingFiles = files
            .filter(file => file.type !== 2) // 디렉토리(type 2) 제외
            .filter(file => file.name.startsWith(`${globalItem.LOT_ID}_${globalItem.EQPID}_${globalItem.STATUS}_`) && file.name.endsWith('.xlsx'));
        
        console.log('Matching files:', matchingFiles); // 매칭된 파일 로깅

        if (matchingFiles.length === 0) {
            throw new Error(`No matching files found in ${basePath}`);
        }

        // 가장 최신 날짜의 파일 찾기
        const latestFile = matchingFiles.sort((a, b) => b.name.localeCompare(a.name))[0].name;
        const remotePath = `${basePath}${latestFile}`;
        console.log(`Downloading file from: ${remotePath}`); // 다운로드 경로 로깅

        await client.downloadTo(localPath, remotePath);

        // 파일이 존재하는지 확인
        if (!fs.existsSync(localPath)) {
            throw new Error(`File not found: ${localPath}`);
        }

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(localPath);
        const worksheet = workbook.getWorksheet(2); // 두 번째 시트

        // B2:S33 범위를 HTML로 변환
        let html = '<table border="1" style="border-collapse: collapse; text-align: center; width: 100%;">';
        const merges = worksheet._merges;
        for (let rowNumber = 2; rowNumber <= 33; rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            const isLastRow = rowNumber === 33; // 마지막 행인지 확인
            html += `<tr${isLastRow ? ' style="background-color: yellow;"' : ''}>`;
            for (let colNumber = 2; colNumber <= 19; colNumber++) {
                const cell = row.getCell(colNumber);
                const cellValue = cell.value || '';
                const cellAddress = cell.address;

                // 병합된 셀 확인
                const mergeCell = merges[cellAddress];
                if (mergeCell) {
                    const { top, left, bottom, right } = mergeCell;
                    const rowspan = bottom - top + 1;
                    const colspan = right - left + 1;
                    html += `<td rowspan="${rowspan}" colspan="${colspan}" style="border: 1px solid black;">${cellValue}</td>`;
                } else {
                    // 병합된 셀의 시작 셀만 값을 표시하고 나머지 셀은 비워둠
                    const isMerged = Object.values(merges).some(merge => {
                        const { top, left, bottom, right } = merge;
                        return rowNumber >= top && rowNumber <= bottom && colNumber >= left && colNumber <= right;
                    });
                    if (!isMerged) {
                        html += `<td style="border: 1px solid black;">${cellValue}</td>`;
                    }
                }
            }
            html += '</tr>';
        }
        html += '</table>';

        res.send(html);
    } catch (error) {
        console.error('Error processing Excel file:', error);
        console.error('Error details:', error.stack); // 스택 트레이스 추가
        res.status(500).send(`Error processing Excel file: ${error.message}`);
    } finally {
        client.close();
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath); // 임시 파일 삭제
        }
    }
});

app.use(express.static(path.join(__dirname, 'public')));


// Probemark 이미지 다운로드 (EQPID 경로 추가)
app.get('/fetchImages', async function (req, res) {
    if (!globalItem || !globalItem.STATUS || !globalItem.LOT_ID || !globalItem.EQPID) {
        return res.status(400).send('STATUS, LOT_ID 또는 EQPID 정보가 설정되지 않았습니다.');
    }

    // 여기요!! - basePath에 EQPID 폴더 경로 추가
    const basePath = `RPA/probemark_Image/${globalItem.STATUS}/${globalItem.EQPID}/${globalItem.LOT_ID}/`;
    const client = new ftp.Client();
    client.ftp.verbose = true;
    // 여기요!! - 리눅스 FTP 서버용 패시브 모드 설정
    client.ftp.pasv = true;

    try {
        await client.access({
            host: "192.168.223.23", // 변경된 FTP 서버 호스트
            user: "hyperauto",      // 변경된 사용자 이름
            password: "Gkdlvj123!@#", // 변경된 비밀번호
            secure: false
        });

        console.log(`Files path: ${basePath}`); // 경로 로깅
        
        // LOT_ID 뒤에 붙는 숫자가 가장 큰 폴더 찾기
        const lotFolders = await client.list(basePath);
        // 여기요!! - 디렉토리만 필터링
        const lotFoldersFiltered = lotFolders.filter(folder => folder.type === 2); // type 2는 디렉토리
        
        if (lotFoldersFiltered.length === 0) {
            throw new Error(`No folders found in ${basePath}`);
        }
        
        const latestLotFolder = lotFoldersFiltered
            .filter(folder => folder.name.startsWith(globalItem.LOT_ID + '.'))
            .sort((a, b) => parseInt(b.name.split('.')[1]) - parseInt(a.name.split('.')[1]))[0].name;

        const lotPath = `${basePath}${latestLotFolder}/`;
        console.log(`Lot path: ${lotPath}`); // 로깅 추가

        // 가장 최신 날짜&시간 폴더 찾기
        const dateFolders = await client.list(lotPath);
        // 여기요!! - 디렉토리만 필터링
        const dateFoldersFiltered = dateFolders.filter(folder => folder.type === 2);
        
        if (dateFoldersFiltered.length === 0) {
            throw new Error(`No date folders found in ${lotPath}`);
        }
        
        const latestDateFolder = dateFoldersFiltered
            .sort((a, b) => b.name.localeCompare(a.name))[0].name;

        const remotePath = `${lotPath}${latestDateFolder}/`;
        console.log(`Remote path: ${remotePath}`); // 로깅 추가
        
        const localDir = path.join(__dirname, 'public', 'images');

        const files = await client.list(remotePath);
        // 여기요!! - 파일만 필터링 (디렉토리 제외)
        //const bmpFiles = files.filter(file => file.type !== 2 && file.name.endsWith('.bmp'));
        const bmpFiles = files.filter(file => file.name.endsWith('.bmp') || file.name.endsWith('.jpg'));

        // Ensure local directory exists
        if (!fs.existsSync(localDir)) {
            fs.mkdirSync(localDir, { recursive: true });
        }

        console.log(`Found ${bmpFiles.length} BMP files`); // 로깅 추가

        // Download images to local directory
        for (const file of bmpFiles) {
            const localPath = path.join(localDir, file.name);
            await client.downloadTo(localPath, `${remotePath}${file.name}`);
        }

        const images = bmpFiles.map(file => ({
            name: file.name,
            path: `/images/${file.name}`
        }));

        res.json(images);
    } catch (error) {
        console.error('Error fetching images:', error);
        console.error('Error details:', error.stack); // 스택 트레이스 추가
        res.status(500).send(`Error fetching images: ${error.message}`);
    } finally {
        client.close();
    }
});

// Contact setup 후 Run동작 실행
app.post('/updateStatus', async (req, res) => {
    const { eqpid, startTime } = req.body;

    try {
        const connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(
            `UPDATE RPA_ADMIN.RPA 
             SET RPA_STATUS = 'Run' 
             WHERE EQP_ID = :eqpid 
             AND START_TIME = TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS.FF')
             AND RPA_STATUS IN  ('Check', 'Error')`,
            [eqpid, startTime],
            { autoCommit: true }
        );

        if (result.rowsAffected === 0) {
            res.status(404).send('No rows updated');
        } else {
            res.send('Status updated successfully');
        }

        await connection.close();
    } catch (error) {
        console.error('Error updating status:', error);
        res.status(500).send('Error updating status');
    }
});

// STOP 동작 실행
app.post('/updateStatus_2', async (req, res) => {
    const { eqpid, startTime, status, finally: finallyStatus, userId } = req.body;

    try {
        const connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(
            `UPDATE RPA_ADMIN.RPA 
             SET RPA_STATUS = :status, FINALLY = :finallyStatus, USERID = :userId
             WHERE EQP_ID = :eqpid 
             AND START_TIME = TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS.FF')
             AND RPA_STATUS IN ('Check', 'Error', 'Run')`,
            [status, finallyStatus, userId, eqpid, startTime],
            { autoCommit: true }
        );

        if (result.rowsAffected === 0) {
            res.status(404).send('No rows updated');
        } else {
            res.send('Status updated successfully');
        }

        await connection.close();
    } catch (error) {
        console.error('Error updating status:', error);
        res.status(500).send('Error updating status');
    }
});

// app.post('/updateStatusWithReason', async (req, res) => {
//     const { eqpid, startTime, reason, detail } = req.body;
    
//     if (!eqpid || !startTime || !reason || !detail) {
//         return res.status(400).send('필수 파라미터가 누락되었습니다.');
//     }
    
//     let connection;
//     try {
//         connection = await oracledb.getConnection(dbConfig1);
        
//         // RPA 테이블에 사유와 상세 내용 저장 (ACTION_SORT, ACTION_COMMENT 컬럼 사용)
//         const result = await connection.execute(
//             `UPDATE RPA_ADMIN.RPA 
//              SET RPA_STATUS = 'OM', 
//                  ACTION_SORT = :reason, 
//                  ACTION_COMMENT = :detail
//              WHERE EQP_ID = :eqpid 
//              AND TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS') BETWEEN 
//                  START_TIME - INTERVAL '1' SECOND AND START_TIME + INTERVAL '1' SECOND`,
//             {
//                 reason: reason,
//                 detail: detail,
//                 eqpid: eqpid,
//                 startTime: startTime
//             },
//             { autoCommit: true }
//         );
        
//         if (result.rowsAffected === 0) {
//             return res.status(404).send('해당하는 RPA 상태 정보를 찾을 수 없습니다.');
//         }
        
//         res.status(200).send('상태 업데이트 완료');
//     } catch (error) {
//         console.error('Error updating RPA status with reason:', error);
//         res.status(500).send('데이터베이스 오류 발생');
//     } finally {
//         if (connection) {
//             try {
//                 await connection.close();
//             } catch (error) {
//                 console.error('Error closing database connection:', error);
//             }
//         }
//     }
// });

app.post('/updateStatusWithReason', async (req, res) => {
    const { eqpid, startTime, reason, detail } = req.body;
    
    if (!eqpid || !startTime || !reason || !detail) {
        return res.status(400).send('필수 파라미터가 누락되었습니다.');
    }
    
    let connection;
    try {
        connection = await oracledb.getConnection(dbConfig1);
        
        // 1. 먼저 원래 인스턴스의 데이터 조회
        const queryResult = await connection.execute(
            `SELECT * FROM RPA_ADMIN.RPA 
             WHERE EQP_ID = :eqpid 
             AND TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS') BETWEEN 
                 START_TIME - INTERVAL '1' SECOND AND START_TIME + INTERVAL '1' SECOND`,
            {
                eqpid: eqpid,
                startTime: startTime
            },
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        
        if (queryResult.rows.length === 0) {
            return res.status(404).send('해당하는 RPA 상태 정보를 찾을 수 없습니다.');
        }
        
        // 2. 원래 인스턴스의 ACTION_SORT, ACTION_COMMENT 값을 업데이트
        const updateResult = await connection.execute(
            `UPDATE RPA_ADMIN.RPA 
             SET ACTION_SORT = :reason, 
                 ACTION_COMMENT = :detail,
                 FINALLY = 'Ok'
             WHERE EQP_ID = :eqpid 
             AND TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS') BETWEEN 
                 START_TIME - INTERVAL '1' SECOND AND START_TIME + INTERVAL '1' SECOND`,
            {
                reason: reason,
                detail: detail,
                eqpid: eqpid,
                startTime: startTime
            },
            { autoCommit: false } // 트랜잭션 유지
        );
        
        // 3. 새 인스턴스 생성을 위한 데이터 준비
        const originalRow = queryResult.rows[0];
        
        // 새 레코드에 사용할 값들을 저장
        let insertParams = {};
        
        // 원본 데이터의 모든 컬럼 복사 (ID 제외)
        for (const [key, value] of Object.entries(originalRow)) {
            if (key !== 'ID') {
                insertParams[key] = value;
            }
        }
        
        // 필요한 컬럼 값 변경
        insertParams.RPA_STATUS = 'OM';
        insertParams.LOT_ID = ''; // LOT_ID를 공백으로 설정
        insertParams.ACTION_SORT = reason;
        insertParams.ACTION_COMMENT = detail;
        
        // 4. 동적 SQL 작성
        const columns = Object.keys(insertParams).filter(key => key !== 'ID');
        const placeholders = columns.map(col => `:${col}`);
        
        const insertQuery = `
            INSERT INTO RPA_ADMIN.RPA (${columns.join(', ')})
            VALUES (${placeholders.join(', ')})
        `;
        
        // 5. 새 레코드 삽입
        await connection.execute(insertQuery, insertParams, { autoCommit: true });
        
        res.status(200).send('상태 업데이트 완료');
    } catch (error) {
        console.error('Error updating RPA status with reason:', error);
        res.status(500).send('데이터베이스 오류 발생: ' + error.message);
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (error) {
                console.error('Error closing database connection:', error);
            }
        }
    }
});

// // RPA 완료시 FINALLY 컬럼 값 수정
// app.post('/updateFinallyColumn', async (req, res) => {
//     const { eqpid, startTime, userId } = req.body;
//     console.log('Received request to updateFinallyColumn:', { eqpid, startTime, userId });

//     try {
//         const connection = await oracledb.getConnection(dbConfig1);
//         const result = await connection.execute(
//             `UPDATE RPA_ADMIN.RPA 
//              SET FINALLY = 'Ok', USERID = :userId
//              WHERE EQP_ID = :eqpid
//              AND START_TIME = TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS.FF')`,
//             { eqpid, startTime, userId }, // 바인드 변수 수정
//             { autoCommit: true }
//         );

//         console.log('Update result:', result);

//         if (result.rowsAffected === 0) {
//             console.log('No rows updated for:', { eqpid, startTime, userId });
//             res.status(404).send('No rows updated');
//         } else {
//             res.json({ success: true, message: 'FINALLY 컬럼 값이 성공적으로 수정되었습니다.' });
//         }

//         await connection.close();
//     } catch (error) {
//         console.error('Error updating FINALLY column:', error);
//         res.status(500).send('Error updating FINALLY column');
//     }
// });

// app.post('/updateFinallyColumn', async (req, res) => {
//     const { eqpid, startTime, userId, finally: finallyValue } = req.body; // 'finally' 값 추가
//     console.log('Received request to updateFinallyColumn:', { eqpid, startTime, userId, finallyValue });

//     try {
//         const connection = await oracledb.getConnection(dbConfig1);
//         const result = await connection.execute(
//             `UPDATE RPA_ADMIN.RPA 
//              SET FINALLY = :finallyValue, USERID = :userId
//              WHERE EQP_ID = :eqpid
//              AND START_TIME = TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS.FF')`,
//             { eqpid, startTime, userId, finallyValue }, // 바인드 변수 수정
//             { autoCommit: true }
//         );

//         console.log('Update result:', result);

//         if (result.rowsAffected === 0) {
//             console.log('No rows updated for:', { eqpid, startTime, userId });
//             res.status(404).send('No rows updated');
//         } else {
//             res.json({ success: true, message: `'Finally' 컬럼 값이 성공적으로 '${finallyValue}'로 수정되었습니다.` });
//         }

//         await connection.close();
//     } catch (error) {
//         console.error('Error updating FINALLY column:', error);
//         res.status(500).send('Error updating FINALLY column');
//     }
// });

app.post('/updateFinallyColumn', async (req, res) => {
    const { eqpid, startTime, userId, finallyValue } = req.body; // finallyValue 추가
    try {
        const connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(
            `UPDATE RPA_ADMIN.RPA 
             SET FINALLY = :finallyValue, USERID = :userId
             WHERE EQP_ID = :eqpid
             AND START_TIME = TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS.FF')`,
            { eqpid, startTime, userId, finallyValue }, // finallyValue 바인딩
            { autoCommit: true }
        );

        if (result.rowsAffected === 0) {
            res.status(404).send('No rows updated');
        } else {
            res.json({ success: true, message: 'FINALLY 컬럼 값이 성공적으로 수정되었습니다.' });
        }
    } catch (error) {
        console.error('Error updating FINALLY column:', error);
        res.status(500).send('Error updating FINALLY column');
    }
});


// 전역변수 설정
let globalItem = null;

// 특정 엔드포인트에서 globalItem 설정
app.post('/setGlobalItem', (req, res) => {
    globalItem = req.body;
    res.json({ success: true, message: 'globalItem이 설정되었습니다.' });
});

// 한도견본 출력
app.get('/generate-image', async (req, res) => {
    if (!globalItem || !globalItem.DEVICE) {
        return res.status(400).send('DEVICE 정보가 설정되지 않았습니다.');
    }

    const client = new ftp.Client();
    client.ftp.verbose = true;
    const localPath = path.join(__dirname, 'temp.xlsx');
    const device = globalItem.DEVICE; // 전역 변수에서 DEVICE 값을 가져옴

    try {
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });

        const remotePath = `RPA/제품별한도견본/${device}_한도견본.xlsx`; // DEVICE 값을 기반으로 파일명 설정
        await client.downloadTo(localPath, remotePath);

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(localPath);
        const worksheet = workbook.getWorksheet(1);

        // A1:A10 범위를 추출 (병합된 셀 고려)
        let textData = [];
        let previousValue = null;
        for (let rowNumber = 1; rowNumber <= 10; rowNumber++) {
            const cell = worksheet.getRow(rowNumber).getCell(1); // A열의 셀 값 추출
            const cellValue = cell.value !== null ? cell.value.toString() : '0'; // 셀 값이 null인 경우 '0'으로 설정
            if (cellValue !== previousValue) {
                textData.push(cellValue);
                previousValue = cellValue;
            }
        }

        // 두 번째 시트에서 이미지 추출
        const secondSheet = workbook.getWorksheet(2);
        let imageData = [];
        const images = secondSheet.getImages();
        images.forEach(image => {
            const { range, imageId } = image;
            const imageBuffer = workbook.model.media.find(media => media.index === imageId).buffer;
            const base64Image = imageBuffer.toString('base64');
            imageData.push(`data:image/png;base64,${base64Image}`);
        });

        res.json({ textData, imageData });
    } catch (error) {
        console.error('Error generating image:', error);
        res.status(500).send('Error generating image');
    } finally {
        client.close();
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }
    }
});

// 누적 최종데이터 추출
app.get('/Detailed-Report', async function (req, res) {
    const { fileName, sortValue, eqpid } = req.query;  // eqpId 대신 machine 사용
    console.log("Received Detailed-Report request:", { fileName, sortValue, eqpid });
    
    if (!fileName || !sortValue || !eqpid) {
        return res.status(400).send('fileName, sortValue, and machine parameters are required');
    }

    const basePath = `RPA/Report/${sortValue}/${eqpid}/`;  // 장비명(machine)을 경로에 추가
    console.log(`Base path: ${basePath}`);
    
    const client = new ftp.Client();
    client.ftp.verbose = true;
    const localPath = path.join(__dirname, 'temp.xlsx');

    try {
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });

        // 해당 경로의 파일 목록 가져오기
        const files = await client.list(basePath);
        console.log('Files in directory:', files); // 파일 목록 로그 출력

        // 파일 이름 비교 로그 추가
        const fileNameOnly = path.basename(fileName); // 경로를 제거한 파일 이름
        files.forEach(file => {
            console.log(`Comparing: ${file.name} with ${fileNameOnly}`);
        });

        const matchingFiles = files.filter(file => file.name === fileNameOnly);
        console.log('Matching files:', matchingFiles); // 매칭되는 파일 로그 출력

        if (matchingFiles.length === 0) {
            throw new Error('No matching files found');
        }

        const remotePath = `${basePath}${fileNameOnly}`;
        console.log(`Attempting to download file from: ${remotePath}`); // 경로를 로그로 출력

        await client.downloadTo(localPath, remotePath);

        // 파일이 존재하는지 확인
        if (!fs.existsSync(localPath)) {
            throw new Error(`File not found: ${localPath}`);
        }

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(localPath);
        const worksheet = workbook.getWorksheet(2); // 두 번째 시트

        // B2:S58 범위를 HTML로 변환
        let html = '<table border="1" style="border-collapse: collapse; text-align: center; width: 100%;">';
        const merges = worksheet._merges;
        for (let rowNumber = 2; rowNumber <= 22; rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            html += '<tr>';
            for (let colNumber = 2; colNumber <= 19; colNumber++) {
                const cell = row.getCell(colNumber);
                const cellValue = cell.value || '';
                const cellAddress = cell.address;

                // 병합된 셀 확인
                const mergeCell = merges[cellAddress];
                if (mergeCell) {
                    const { top, left, bottom, right } = mergeCell;
                    const rowspan = bottom - top + 1;
                    const colspan = right - left + 1;
                    html += `<td rowspan="${rowspan}" colspan="${colspan}" style="border: 1px solid black;">${cellValue}</td>`;
                } else {
                    // 병합된 셀의 시작 셀만 값을 표시하고 나머지 셀은 비워둠
                    const isMerged = Object.values(merges).some(merge => {
                        const { top, left, bottom, right } = merge;
                        return rowNumber >= top && rowNumber <= bottom && colNumber >= left && colNumber <= right;
                    });
                    if (!isMerged) {
                        html += `<td style="border: 1px solid black;">${cellValue}</td>`;
                    }
                }
            }
            html += '</tr>';
        }
        html += '</table>';

        // 이미지 추출
        const images = worksheet.getImages();
        let imageHtml = '<div style="display: flex; flex-wrap: wrap;">';
        for (const image of images) {
            const imageId = image.imageId;
            const imageBuffer = workbook.model.media.find(media => media.index === imageId).buffer;
            const base64Image = imageBuffer.toString('base64');
            imageHtml += `
                <div style="width: 50%; padding: 10px; box-sizing: border-box;">
                    <div style="border: 1px solid black; padding: 10px;">
                        <img src="data:image/png;base64,${base64Image}" style="width: 100%; height: auto;" />
                    </div>
                </div>`;
        }
        imageHtml += '</div>';

        html += imageHtml;

        res.send(html);
    } catch (error) {
        console.error('Error fetching Excel file:', error);
        res.status(500).send('Error fetching Excel file');
    } finally {
        client.close();
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath); // 임시 파일 삭제
        }
    }
});

// Ball Size 정의
async function getBallSize(device) {
    let connection;
    try {
        // device의 앞 8자리만 추출
        const devicePrefix = device.substring(0, 8);
        console.log(`원본 장비명: ${device}, 검색용 장비명(앞 8자리): ${devicePrefix}`);
        
        connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(
            `SELECT BALL_SIZE FROM RPA_ADMIN.ball_size WHERE DEVICE = :devicePrefix`,
            [devicePrefix]
        );
        
        if (result.rows.length > 0) {
            console.log(`장비 ${devicePrefix}의 볼 사이즈: ${result.rows[0][0]}`);
            return result.rows[0][0]; // BALL_SIZE 값 반환
        } else {
            console.log(`장비 ${devicePrefix}에 대한 볼 사이즈 정보가 없습니다.`);
            return 80; // 기본 크기 반환 (없을 경우 기본값)
        }
    } catch (err) {
        console.error('볼 사이즈 조회 중 오류 발생:', err);
        return 80; // 오류 발생 시 기본값 반환
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error('DB 연결 종료 중 오류:', err);
            }
        }
    }
}


app.get('/setCursorStyle', async function (req, res) {
    console.log("setCursorStyle 호출됨");
    
    if (!globalItem || !globalItem.DEVICE) {
        console.log("globalItem 또는 DEVICE가 없음:", globalItem);
        return res.status(400).send('DEVICE 정보가 설정되지 않았습니다.');
    }

    const device = globalItem.DEVICE;
    console.log("현재 장비명:", device);

    try {
        // 배율 감안하여 2배율 적용
        const ballSize = await getBallSize(device) * 2;
        console.log("조회된 볼 사이즈:", ballSize);
        
        const innerCircleSize = ballSize * 0.6;
        
        // 크기에 따라 SVG 또는 CSS 방식 선택
        const useSvgCursor = ballSize <= 128; // 128px 이하일 때만 SVG 커서 사용
        
        if (useSvgCursor) {
            // SVG 방식
            const cursorSvg = `
                <svg width="${ballSize}" height="${ballSize}" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="${ballSize / 2}" cy="${ballSize / 2}" r="${ballSize / 2}" stroke="green" stroke-width="2" fill="none" />
                    <circle cx="${ballSize / 2}" cy="${ballSize / 2}" r="${innerCircleSize / 2}" stroke="red" stroke-width="2" fill="none" />
                    <text x="${ballSize + 5}" y="${ballSize / 2 + 5}" font-family="Arial" font-size="14" fill="black" font-weight="bold">${ballSize}</text>
                </svg>
            `;
            const cursorUrl = `data:image/svg+xml;base64,${Buffer.from(cursorSvg).toString('base64')}`;
            
            const styleCode = `
                #inspection-images-container:hover {
                    cursor: url('${cursorUrl}') ${ballSize / 2} ${ballSize / 2}, auto;
                }
                
                #ball-size-badge {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background-color: rgba(0, 0, 0, 0.8);
                    color: white;
                    padding: 10px;
                    border-radius: 5px;
                    font-size: 16px;
                    font-weight: bold;
                    z-index: 9999;
                }
            `;
            
            // 여기요!! - SVG 방식에서 장비명 추가
            const scriptCode = `
                <script>
                    const existingBadge = document.getElementById('ball-size-badge');
                    if (existingBadge) existingBadge.remove();
                    
                    const badge = document.createElement('div');
                    badge.id = 'ball-size-badge';
                    badge.innerHTML = '<div>장비: ${device} | 볼 사이즈: ${ballSize}</div>';
                    document.body.appendChild(badge);
                    
                    // 기존 커스텀 커서 제거 (있을 경우)
                    const existingCursor = document.getElementById('custom-cursor');
                    if (existingCursor) existingCursor.remove();
                </script>
            `;
            
            res.send(styleCode + scriptCode);
        } else {
            // CSS/JS 방식 (큰 사이즈용)
            const styleCode = `
                <style>
                    #inspection-images-container {
                        position: relative !important;
                        cursor: none !important;
                    }
                    
                    #custom-cursor {
                        position: absolute;
                        width: ${ballSize}px;
                        height: ${ballSize}px;
                        border: 2px solid green;
                        border-radius: 50%;
                        pointer-events: none;
                        transform: translate(-50%, -50%);
                        z-index: 9999;
                        display: none;
                    }
                    
                    #custom-cursor::after {
                        content: "";
                        position: absolute;
                        width: ${innerCircleSize}px;
                        height: ${innerCircleSize}px;
                        border: 2px solid red;
                        border-radius: 50%;
                        top: 50%;
                        left: 50%;
                        transform: translate(-50%, -50%);
                    }
                    
                    #ball-size-badge {
                        position: fixed;
                        top: 20px;
                        right: 20px;
                        background-color: rgba(0, 0, 0, 0.8);
                        color: white;
                        padding: 10px;
                        border-radius: 5px;
                        font-size: 16px;
                        font-weight: bold;
                        z-index: 9999;
                    }
                </style>
            `;
            
            // CSS 방식에서 장비명 추가
            const scriptCode = `
                <script>
                    // 배지 업데이트
                    const existingBadge = document.getElementById('ball-size-badge');
                    if (existingBadge) existingBadge.remove();
                    
                    const badge = document.createElement('div');
                    badge.id = 'ball-size-badge';
                    badge.innerHTML = '<div>장비: ${device} | 볼 사이즈: ${ballSize}</div>';
                    document.body.appendChild(badge);
                    
                    // 커스텀 커서 생성
                    const existingCursor = document.getElementById('custom-cursor');
                    if (existingCursor) existingCursor.remove();
                    
                    const cursor = document.createElement('div');
                    cursor.id = 'custom-cursor';
                    
                    // 이벤트 처리
                    window.addEventListener('DOMContentLoaded', function() {
                        const container = document.getElementById('inspection-images-container');
                        if (container) {
                            container.appendChild(cursor);
                            
                            container.addEventListener('mousemove', function(e) {
                                const rect = container.getBoundingClientRect();
                                const x = e.clientX - rect.left;
                                const y = e.clientY - rect.top;
                                cursor.style.left = x + 'px';
                                cursor.style.top = y + 'px';
                                cursor.style.display = 'block';
                            });
                            
                            container.addEventListener('mouseleave', function() {
                                cursor.style.display = 'none';
                            });
                            
                            container.addEventListener('mouseenter', function() {
                                cursor.style.display = 'block';
                            });
                        }
                    });
                    
                    if (document.readyState === 'interactive' || document.readyState === 'complete') {
                        const event = new Event('DOMContentLoaded');
                        window.dispatchEvent(event);
                    }
                </script>
            `;
            
            res.send(styleCode + scriptCode);
        }
    } catch (error) {
        console.error('커서 스타일 설정 중 오류:', error);
        
        // 오류 발생 시에도 장비명 포함
        const defaultBallSize = 80;
        const defaultStyle = `
            <style>
                #ball-size-badge {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background-color: rgba(255, 0, 0, 0.8);
                    color: white;
                    padding: 10px;
                    border-radius: 5px;
                    font-size: 16px;
                    font-weight: bold;
                    z-index: 9999;
                }
            </style>
        `;
        
        const defaultScript = `
            <script>
                const existingBadge = document.getElementById('ball-size-badge');
                if (existingBadge) existingBadge.remove();
                
                const badge = document.createElement('div');
                badge.id = 'ball-size-badge';
                badge.innerHTML = '<div>장비: ${device} | 볼 사이즈: ${defaultBallSize} (오류)</div>';
                document.body.appendChild(badge);
            </script>
        `;
        
        res.send(defaultStyle + defaultScript);
    }
});


// getErrorDetails 엔드포인트 추가
app.get('/getErrorDetails', async function (req, res) {
    const { eqpid, lotId } = req.query;
    
    if (!eqpid || !lotId) {
        return res.status(400).json({ error: '필수 파라미터가 누락되었습니다.' });
    }
    
    let connection;
    try {
        connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(`
            SELECT 
                RPA_STATUS,
                ERROR_ME AS ERROR_MESSAGE
            FROM 
                RPA_ADMIN.RPA r
            WHERE 
                r.EQP_ID = :eqpid 
                AND r.LOT_ID = :lotId
                AND r.RPA_STATUS = 'Error'
            ORDER BY START_TIME DESC
        `, [eqpid, lotId]);
        
        // 결과를 객체 배열로 변환
        const errorDetails = result.rows.map(row => ({
            RPA_STATUS: row[0],
            ERROR_MESSAGE: row[1] || '상세 오류 메시지가 없습니다.'
        }));
        
        res.json(errorDetails);
    } catch (err) {
        console.error('Error fetching error details:', err);
        res.status(500).json({ error: '에러 정보를 가져오는 데 실패했습니다.' });
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error('DB 연결 종료 중 오류:', err);
            }
        }
    }
});

// Remote 엔드포인트 추가
app.get('/remote', function (req, res) {
    res.sendFile(path.join(__dirname, 'Remote.html'));
});

