import Foundation

extension APIClient {
    public struct UploadFile: Sendable {
        public var filename: String
        public var data: Data

        public init(filename: String, data: Data) {
            self.filename = filename
            self.data = data
        }
    }

    public struct UploadResponse: Decodable, Sendable {
        public var success: Bool
        public var files: [String]
    }

    public func uploadFiles(_ spaceId: String, files: [UploadFile]) async throws -> UploadResponse {
        guard !files.isEmpty else { return UploadResponse(success: true, files: []) }
        guard files.count <= 20 else {
            throw APIError(statusCode: 400, message: "Choose no more than 20 files at once")
        }

        let boundary = "Waynode-\(UUID().uuidString)"
        var body = Data()
        for file in files {
            let name = safeMultipartFilename(file.filename)
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"files\"; filename=\"\(name)\"\r\n".utf8))
            body.append(Data("Content-Type: application/octet-stream\r\n\r\n".utf8))
            body.append(file.data)
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))

        var request = URLRequest(url: makeURL("/api/spaces/\(spaceId)/upload"))
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = 120
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = currentToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(statusCode: -1, message: "Invalid upload response")
        }
        if http.statusCode == 401 {
            onUnauthorized.yield()
            throw APIError(statusCode: 401, message: "Unauthorized")
        }
        guard (200...299).contains(http.statusCode) else {
            let detail = (try? JSONDecoder().decode(UploadError.self, from: data))
            throw APIError(
                statusCode: http.statusCode,
                message: detail?.error ?? detail?.err ?? "Upload failed (HTTP \(http.statusCode))"
            )
        }
        do {
            return try JSONDecoder().decode(UploadResponse.self, from: data)
        } catch {
            throw APIError(statusCode: -1, message: "Upload response could not be read")
        }
    }

    private func safeMultipartFilename(_ filename: String) -> String {
        let leaf = URL(fileURLWithPath: filename).lastPathComponent
        return leaf
            .replacingOccurrences(of: "\"", with: "'")
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
    }

    private struct UploadError: Decodable {
        var error: String?
        var err: String?
    }
}
